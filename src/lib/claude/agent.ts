import Anthropic from '@anthropic-ai/sdk';
import type { CategorySlug } from '@/types';
import {
  getUserByTelegramId,
  getCategories,
  getCategoryBySlug,
  insertTransaction,
  softDeleteTransaction,
  getLastTransaction,
  getLastNTransactionsFamily,
  getMonthSummary,
  getRecentMessages,
  saveMessage,
  addDebt,
  payDebt,
  getActiveDebts,
} from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, monthNameRu, formatTenge } from '@/lib/utils';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const VALID_SLUGS: CategorySlug[] = [
  'home', 'food', 'transport', 'cafe', 'baby',
  'health', 'credit', 'personal', 'savings', 'misc',
];

// ═══════════════════════════════════════════════════════════════
// PATTERN DETECTION — determine user intent from text
// ═══════════════════════════════════════════════════════════════

function tryParseExpenses(text: string): { amount: number; description: string }[] | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results: { amount: number; description: string }[] = [];

  for (const line of lines) {
    const match1 = line.match(/^(.+?)\s+(\d[\d\s]*\d|\d+)\s*$/);
    const match2 = line.match(/^(\d[\d\s]*\d|\d+)\s+(.+?)$/);

    if (match1) {
      const amount = parseInt(match1[2].replace(/\s/g, ''), 10);
      if (amount > 0 && amount <= 10_000_000) results.push({ amount, description: match1[1].trim() });
    } else if (match2) {
      const amount = parseInt(match2[1].replace(/\s/g, ''), 10);
      if (amount > 0 && amount <= 10_000_000) results.push({ amount, description: match2[2].trim() });
    }
  }

  if (results.length > 0) return results;
  return null;
}

function tryParseIncome(text: string): { amount: number; comment: string } | null {
  const lower = text.toLowerCase();
  const incomeWords = /зарплат|доход|получил|премия|бонус|фриланс|перевод|вернули/;
  if (!incomeWords.test(lower)) return null;

  const amountMatch = text.match(/(\d[\d\s]*\d|\d+)/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  if (amount <= 0) return null;

  const comment = text.replace(amountMatch[0], '').replace(/тенге|тг|₸/gi, '').trim();
  return { amount, comment: comment || 'доход' };
}

function tryParseDebt(text: string): { amount: number; name: string } | null {
  const lower = text.toLowerCase();
  if (!/взял в долг|занял|одолжил|кредит взял/i.test(lower)) return null;

  const amountMatch = text.match(/(\d[\d\s]*\d|\d+)/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  if (amount <= 0) return null;

  // Extract name: everything after the amount, or after "у"
  let name = text.replace(amountMatch[0], '').replace(/взял в долг|занял|одолжил|кредит взял|тенге|тг|₸|у\s/gi, '').trim();
  if (!name) name = 'без имени';
  return { amount, name };
}

function isUndoRequest(text: string): boolean {
  return /удали|отмени|undo|убери последн|верни назад|отмена/i.test(text);
}

// ═══════════════════════════════════════════════════════════════
// DETERMINISTIC DB HANDLERS — no hallucination possible
// ═══════════════════════════════════════════════════════════════

async function categorize(description: string): Promise<CategorySlug> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 50,
      system: `Определи категорию расхода. Верни ТОЛЬКО slug: home, food, transport, cafe, baby, health, credit, personal, savings, misc`,
      messages: [{ role: 'user', content: description }],
    });
    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim().toLowerCase() : '';
    if (VALID_SLUGS.includes(text as CategorySlug)) return text as CategorySlug;
  } catch { /* fallback */ }
  return 'misc';
}

function buildSummaryText(summary: ReturnType<typeof getMonthSummary> extends Promise<infer T> ? T : never): string {
  const total = summary.total_actual;
  const activeCats = summary.categories.filter(
    (c: { actual: number; planned: number }) => c.actual > 0 || c.planned > 0
  );
  const sorted = [...activeCats].sort(
    (a: { actual: number }, b: { actual: number }) => b.actual - a.actual
  );

  const { year, month } = currentMonthAlmaty();
  let text = `📊 ${monthNameRu(month)} ${year} — Всего: ${formatTenge(total)}`;
  if (summary.total_planned > 0) text += ` из ${formatTenge(summary.total_planned)}`;
  text += '\n\n';

  for (const c of sorted) {
    const cat = c as { category: { emoji: string; name: string }; actual: number; planned: number; percentage: number };
    const share = total > 0 ? Math.round((cat.actual / total) * 100) : 0;
    text += `- ${cat.category.emoji} ${cat.category.name}: ${formatTenge(cat.actual)} (${share}%)`;
    if (cat.planned > 0) text += ` · ${cat.percentage}% плана`;
    text += '\n';
  }

  if (summary.total_income > 0) {
    const balance = summary.total_income - total;
    text += `\n📥 Доход: ${formatTenge(summary.total_income)} · Баланс: ${balance >= 0 ? '+' : ''}${formatTenge(balance)}`;
  }

  return text.trim();
}

async function handleExpenses(
  expenses: { amount: number; description: string }[],
  userId: string,
): Promise<string> {
  const results: string[] = [];
  const errors: string[] = [];

  for (const exp of expenses) {
    const slug = await categorize(exp.description);
    const category = await getCategoryBySlug(slug);
    if (!category) { errors.push(`❌ ${exp.description}: категория не найдена`); continue; }

    try {
      await insertTransaction({
        user_id: userId,
        category_id: category.id,
        type: 'expense',
        amount: exp.amount,
        comment: exp.description,
        source: 'telegram',
        transaction_date: todayAlmaty(),
      });

      let extra = '';
      if (slug === 'credit') {
        const debt = await payDebt(exp.description, exp.amount);
        if (debt) {
          extra = debt.remaining_amount > 0
            ? ` · долг ${debt.name}: ост. ${formatTenge(debt.remaining_amount)}`
            : ` · 🎉 долг ${debt.name} погашен!`;
        }
      }

      results.push(`✅ ${category.emoji} ${category.name} — ${formatTenge(exp.amount)} (${exp.description})${extra}`);
    } catch (e) {
      errors.push(`❌ ${exp.description} ${formatTenge(exp.amount)}: ${e instanceof Error ? e.message : 'ошибка'}`);
    }
  }

  const { year, month } = currentMonthAlmaty();
  const summary = await getMonthSummary(year, month);
  let reply = results.concat(errors).join('\n');
  reply += '\n\n' + buildSummaryText(summary);
  return reply;
}

async function handleIncome(income: { amount: number; comment: string }, userId: string): Promise<string> {
  try {
    await insertTransaction({
      user_id: userId,
      category_id: null,
      type: 'income',
      amount: income.amount,
      comment: income.comment,
      source: 'telegram',
      transaction_date: todayAlmaty(),
    });
  } catch (e) {
    return `❌ Доход НЕ сохранён: ${e instanceof Error ? e.message : 'ошибка'}`;
  }

  const { year, month } = currentMonthAlmaty();
  const summary = await getMonthSummary(year, month);
  const balance = summary.total_income - summary.total_actual;

  let reply = `💰 Доход записан: ${formatTenge(income.amount)} (${income.comment})`;
  reply += `\n\n📥 Доход за ${monthNameRu(month)}: ${formatTenge(summary.total_income)}`;
  reply += `\n📤 Расходы: ${formatTenge(summary.total_actual)}`;
  reply += `\n💼 Баланс: ${balance >= 0 ? '+' : ''}${formatTenge(balance)}`;
  return reply;
}

async function handleDebt(debt: { amount: number; name: string }): Promise<string> {
  try {
    const d = await addDebt(debt.name, debt.amount);
    const allDebts = await getActiveDebts();
    const totalDebt = allDebts.reduce((s, x) => s + x.remaining_amount, 0);

    let reply = `📝 Долг записан: ${formatTenge(debt.amount)} (${d.name})`;
    reply += `\nОстаток по этому долгу: ${formatTenge(d.remaining_amount)}`;
    reply += `\n\n💳 Всего долгов: ${formatTenge(totalDebt)}`;
    for (const x of allDebts) {
      reply += `\n- ${x.name}: ${formatTenge(x.remaining_amount)}`;
    }
    return reply;
  } catch (e) {
    return `❌ Долг НЕ записан: ${e instanceof Error ? e.message : 'ошибка'}`;
  }
}

async function handleUndo(userId: string): Promise<string> {
  const last = await getLastTransaction(userId);
  if (!last) return '📭 Нет транзакций для удаления.';

  const categories = await getCategories();
  const cat = categories.find(c => c.id === last.category_id);

  try {
    await softDeleteTransaction(last.id);
    return `🗑️ Удалено: ${cat?.emoji ?? ''} ${formatTenge(last.amount)}${last.comment ? ` — ${last.comment}` : ''}`;
  } catch (e) {
    return `❌ Не удалось удалить: ${e instanceof Error ? e.message : 'ошибка'}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE — read-only tools for questions and summaries
// ═══════════════════════════════════════════════════════════════

const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_month_summary',
    description: 'Get budget summary. Use when user asks about budget, expenses, remaining, plan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number' },
        month: { type: 'number' },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'get_recent_transactions',
    description: 'Get recent transactions. Use when user asks to see expenses list.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'Max 20', default: 10 },
      },
      required: [],
    },
  },
  {
    name: 'get_debts',
    description: 'Show active debts.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

function buildSystemPrompt(): string {
  const { year, month } = currentMonthAlmaty();
  const today = todayAlmaty();

  return `Ты — семейный финансовый ассистент. Кратко, на русском.

Сегодня: ${today}. Месяц: ${monthNameRu(month)} ${year}.

ВАЖНО: Ты НЕ МОЖЕШЬ записывать расходы, доходы или долги. У тебя нет tools для записи.
Запись делает система автоматически. Ты только отвечаешь на вопросы и показываешь данные.

Результаты tools — готовый текст. Выводи ДОСЛОВНО, не переформатируй.

Если пользователь просит записать расход/доход/долг — скажи "Напишите в формате: кофе 1200"`;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
}

async function executeReadTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case 'get_month_summary': {
      const year = input.year as number;
      const mo = input.month as number;
      const summary = await getMonthSummary(year, mo);
      return buildSummaryText(summary);
    }

    case 'get_recent_transactions': {
      const count = Math.min((input.count as number) || 10, 20);
      const txns = await getLastNTransactionsFamily(count);
      const categories = await getCategories();
      const catMap = new Map(categories.map(c => [c.id, c]));

      if (txns.length === 0) return '📭 Нет транзакций.';

      let text = `📋 Последние ${txns.length} записей:\n\n`;
      for (const t of txns) {
        const cat = t.category_id ? catMap.get(t.category_id) : null;
        const icon = t.type === 'income' ? '📥' : (cat?.emoji ?? '❓');
        text += `${t.transaction_date} | ${icon} ${formatTenge(t.amount)}`;
        if (t.comment) text += ` — ${t.comment}`;
        text += '\n';
      }
      return text.trim();
    }

    case 'get_debts': {
      const debts = await getActiveDebts();
      if (debts.length === 0) return '🎉 Нет активных долгов!';

      const totalDebt = debts.reduce((s, d) => s + d.remaining_amount, 0);
      const totalOriginal = debts.reduce((s, d) => s + d.original_amount, 0);
      const paidOff = totalOriginal - totalDebt;
      const pct = totalOriginal > 0 ? Math.round((paidOff / totalOriginal) * 100) : 0;

      let text = `💳 Долги — ${formatTenge(totalDebt)} осталось`;
      text += `\n📊 Погашено ${formatTenge(paidOff)} из ${formatTenge(totalOriginal)} (${pct}%)`;
      for (const d of debts) {
        text += `\n- ${d.name}: ${formatTenge(d.remaining_amount)}`;
      }
      return text;
    }

    default:
      return 'Неизвестная команда.';
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════

export async function chat(
  userMessage: string,
  telegramId: number,
  userName: string,
  chatId: number
): Promise<string> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return '⛔ Пользователь не найден в системе.';

  const text = userMessage.trim();

  // ── 1. Undo (deterministic) ──
  if (isUndoRequest(text)) {
    const reply = await handleUndo(user.id);
    try { await saveMessage(chatId, 'user', `[${userName}]: ${text}`); } catch { /* */ }
    try { await saveMessage(chatId, 'assistant', reply); } catch { /* */ }
    return reply;
  }

  // ── 2. Debt (deterministic) ──
  const debt = tryParseDebt(text);
  if (debt) {
    const reply = await handleDebt(debt);
    try { await saveMessage(chatId, 'user', `[${userName}]: ${text}`); } catch { /* */ }
    try { await saveMessage(chatId, 'assistant', reply); } catch { /* */ }
    return reply;
  }

  // ── 3. Income (deterministic) ──
  const income = tryParseIncome(text);
  if (income) {
    const reply = await handleIncome(income, user.id);
    try { await saveMessage(chatId, 'user', `[${userName}]: ${text}`); } catch { /* */ }
    try { await saveMessage(chatId, 'assistant', reply); } catch { /* */ }
    return reply;
  }

  // ── 4. Expenses (deterministic) ──
  const expenses = tryParseExpenses(text);
  if (expenses) {
    const reply = await handleExpenses(expenses, user.id);
    try { await saveMessage(chatId, 'user', `[${userName}]: ${text}`); } catch { /* */ }
    try { await saveMessage(chatId, 'assistant', reply); } catch { /* */ }
    return reply;
  }

  // ── 5. Everything else → Claude (read-only tools) ──
  let history: { role: string; content: string }[] = [];
  try { history = await getRecentMessages(chatId, 10); } catch { /* */ }

  const messages: Anthropic.MessageParam[] = [];
  for (const msg of history) {
    if (messages.length === 0 && msg.role === 'assistant') continue;
    if (messages.length > 0 && messages[messages.length - 1].role === msg.role) continue;
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages.pop();
  }

  messages.push({ role: 'user', content: `[${userName}]: ${text}` });
  try { await saveMessage(chatId, 'user', `[${userName}]: ${text}`); } catch { /* */ }

  let finalReply = '';

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: READ_TOOLS,
      messages,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');
    const turnText = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n').trim();
    if (turnText) finalReply = turnText;

    if (toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: ToolResult[] = [];
    for (const block of toolUses) {
      if (block.type === 'tool_use') {
        const result = await executeReadTool(block.name, block.input as Record<string, unknown>);
        toolResults.push({ tool_use_id: block.id, content: result });
      }
    }
    messages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
      })),
    });

    if (response.stop_reason === 'end_turn') break;
  }

  if (!finalReply) finalReply = '🤔';

  try { await saveMessage(chatId, 'assistant', finalReply); } catch { /* */ }
  return finalReply;
}
