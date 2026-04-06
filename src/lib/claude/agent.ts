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
  upsertMonthlyPlan,
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

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'record_expense',
    description: 'Record a new expense. Use when user mentions spending money.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Amount in tenge' },
        category_slug: { type: 'string', enum: VALID_SLUGS, description: 'Category' },
        comment: { type: 'string', description: 'Brief description' },
      },
      required: ['amount', 'category_slug'],
    },
  },
  {
    name: 'get_month_summary',
    description: 'Get current month budget summary with plan vs actual per category. Use when user asks about budget status, how much spent, remaining, etc.',
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
    description: 'Get recent transactions. Use when user asks to see expenses, last purchases, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'Number of transactions to fetch (max 20)', default: 10 },
      },
      required: [],
    },
  },
  {
    name: 'undo_last',
    description: 'Delete the last transaction. Use when user says undo, delete last, made a mistake, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_plan',
    description: 'Set the budget plan for a category for a given month. Use when user wants to set or change budget.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category_slug: { type: 'string', enum: VALID_SLUGS },
        amount: { type: 'number', description: 'Planned budget in tenge' },
        year: { type: 'number' },
        month: { type: 'number' },
      },
      required: ['category_slug', 'amount', 'year', 'month'],
    },
  },
  {
    name: 'record_income',
    description: 'Record income (salary, bonus, refund, gift received). Use when user mentions EARNING money, getting paid. NOT for loans/debts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Income amount in tenge' },
        comment: { type: 'string', description: 'Source of income (зарплата, бонус, etc.)' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'record_debt',
    description: 'Record taking on debt / borrowing money. Use when user says "взял в долг", "одолжил", "занял". NOT income — this is borrowed money that must be paid back.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Amount borrowed in tenge' },
        name: { type: 'string', description: 'Who the debt is from (person or bank name)' },
      },
      required: ['amount', 'name'],
    },
  },
  {
    name: 'get_debts',
    description: 'Show active debts. Use when user asks about debts, how much they owe, долги.',
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

  return `Ты — семейный финансовый ассистент бот. Общаешься на русском языке, кратко и по делу.

Сегодня: ${today}. Текущий месяц: ${monthNameRu(month)} ${year}.

Категории расходов:
- home (Жильё 🏠): квартира, коммуналка, аренда
- food (Продукты 🛒): магазин, еда домой
- transport (Транспорт 🚗): такси, бензин, автобус
- cafe (Кафе & выход ☕): кофе, рестораны, обеды вне дома
- baby (Балапанчик 👶): ребёнок, памперсы, педиатр
- health (Здоровье 💊): аптека, врачи
- credit (Кредиты 💳): платежи по кредитам
- personal (Личное 🎯): стрижка, одежда, подписки
- savings (Savings 💰): сбережения
- misc (Разное 🎲): подарки, непредвиденное

КРИТИЧЕСКИ ВАЖНО: результаты tools содержат ГОТОВЫЙ текст для пользователя. Твоя задача — вывести этот текст ДОСЛОВНО, ОДИН В ОДИН, без изменений. ЗАПРЕЩЕНО: переписывать, перефразировать, менять формат, добавлять маркеры "-", менять порядок строк, добавлять "Итог" или другие заголовки. Просто скопируй текст из tool result как есть.

Правила:
1. Расход (напр. "такси 2500") — вызови record_expense + get_month_summary. Выведи оба результата подряд.
2. Вопрос про бюджет/расходы/план — вызови get_month_summary.
3. Показать транзакции — используй get_recent_transactions
4. Удалить/отменить — используй undo_last
5. Установить план/бюджет — используй set_plan
6. Доход (напр. "зарплата 500000") — используй record_income. Доход = заработанные деньги.
7. Долг (напр. "взял в долг 100000 Дудар", "занял 50000") — используй record_debt. Долг ≠ доход.
8. Оплата кредита (напр. "кредит дудар 30000") — record_expense в категории credit. Имя кредитора пиши в comment — долг автоматически уменьшится.
9. Спросить про долги — используй get_debts.
10. Если непонятно — переспроси.
8. Ты можешь вызвать несколько tools за один ход если нужно (напр. записать расход и показать итог).`;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
}

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string
): Promise<string> {
  switch (toolName) {
    case 'record_expense': {
      const slug = input.category_slug as CategorySlug;
      const amount = Math.round(input.amount as number);
      const comment = (input.comment as string) || undefined;

      if (!Number.isFinite(amount) || amount <= 0) {
        return JSON.stringify({
          error: 'invalid_amount',
          message: 'Сумма должна быть положительным числом. Попроси пользователя уточнить.',
        });
      }

      const category = await getCategoryBySlug(slug);
      if (!category) return JSON.stringify({ error: 'Category not found' });

      await insertTransaction({
        user_id: userId,
        category_id: category.id,
        type: 'expense',
        amount,
        comment,
        source: 'telegram',
        transaction_date: todayAlmaty(),
      });

      // If category is 'credit' and comment has a name, auto-reduce that debt
      let debtNote = '';
      if (slug === 'credit' && comment) {
        const debt = await payDebt(comment, amount);
        if (debt) {
          debtNote = debt.remaining_amount > 0
            ? `\n📉 Долг ${debt.name}: осталось ${formatTenge(debt.remaining_amount)}`
            : `\n🎉 Долг ${debt.name} полностью погашен!`;
        }
      }

      const { year, month } = currentMonthAlmaty();
      const summary = await getMonthSummary(year, month);
      const catSummary = summary.categories.find((c: { category: { id: number } }) => c.category.id === category.id);

      let response = `✅ ${category.emoji} ${category.name} — ${formatTenge(amount)}`;
      if (comment) response += ` (${comment})`;
      response += debtNote;

      if (catSummary && catSummary.planned > 0) {
        response += `\nПо статье: ${formatTenge(catSummary.actual)} из ${formatTenge(catSummary.planned)} (${catSummary.percentage}%)`;
        if (catSummary.remaining > 0) {
          response += ` — осталось ${formatTenge(catSummary.remaining)}`;
        } else if (catSummary.remaining < 0) {
          response += ` — перерасход ${formatTenge(Math.abs(catSummary.remaining))}`;
        }
      }

      return response;
    }

    case 'get_month_summary': {
      const year = input.year as number;
      const mo = input.month as number;
      const summary = await getMonthSummary(year, mo);

      const activeCats = summary.categories.filter(
        (c: { actual: number; planned: number }) => c.actual > 0 || c.planned > 0
      );

      const total = summary.total_actual;

      // Sort categories by amount descending
      const sorted = [...activeCats].sort(
        (a: { actual: number }, b: { actual: number }) => b.actual - a.actual
      );

      // Header line
      let text = `📊 ${monthNameRu(mo)} ${year} — Всего: ${formatTenge(total)}`;
      if (summary.total_planned > 0) {
        text += ` из ${formatTenge(summary.total_planned)}`;
      }
      text += '\n\n';

      // Each category: dash prefix, sorted by amount, % in parentheses
      for (const c of sorted) {
        const cat = c as { category: { emoji: string; name: string }; actual: number; planned: number; percentage: number };
        const share = total > 0 ? Math.round((cat.actual / total) * 100) : 0;
        text += `- ${cat.category.emoji} ${cat.category.name}: ${formatTenge(cat.actual)} (${share}%)`;
        if (cat.planned > 0) {
          text += ` · ${cat.percentage}% плана`;
        }
        text += '\n';
      }

      // Income/balance if present
      if (summary.total_income > 0) {
        const balance = summary.total_income - total;
        text += `\n📥 Доход: ${formatTenge(summary.total_income)} · Баланс: ${balance >= 0 ? '+' : ''}${formatTenge(balance)}`;
      }

      return text.trim();
    }

    case 'get_recent_transactions': {
      const count = Math.min((input.count as number) || 10, 20);
      const txns = await getLastNTransactionsFamily(count);
      const categories = await getCategories();
      const catMap = new Map(categories.map(c => [c.id, c]));

      const items = txns.map(t => {
        const cat = t.category_id ? catMap.get(t.category_id) : null;
        return {
          date: t.transaction_date,
          amount: t.amount,
          category: cat ? `${cat.emoji} ${cat.name}` : '❓',
          comment: t.comment,
          type: t.type,
        };
      });

      return JSON.stringify({ transactions: items, count: items.length });
    }

    case 'undo_last': {
      const last = await getLastTransaction(userId);
      if (!last) return JSON.stringify({ error: 'Нет транзакций для удаления' });

      const categories = await getCategories();
      const cat = categories.find(c => c.id === last.category_id);

      await softDeleteTransaction(last.id);
      return JSON.stringify({
        deleted: true,
        amount: last.amount,
        category: cat ? `${cat.emoji} ${cat.name}` : '❓',
        comment: last.comment,
      });
    }

    case 'set_plan': {
      const slug = input.category_slug as CategorySlug;
      const amount = Math.round(input.amount as number);
      const year = input.year as number;
      const mo = input.month as number;

      if (!Number.isFinite(amount) || amount < 0) {
        return JSON.stringify({ error: 'invalid_amount', message: 'Бюджет не может быть отрицательным.' });
      }

      const category = await getCategoryBySlug(slug);
      if (!category) return JSON.stringify({ error: 'Category not found' });

      await upsertMonthlyPlan({
        year,
        month: mo,
        category_id: category.id,
        plan_type: 'expense',
        amount,
        created_by: userId,
      });

      return JSON.stringify({
        success: true,
        category_name: category.name,
        category_emoji: category.emoji,
        amount,
        month: monthNameRu(mo),
        year,
      });
    }

    case 'record_income': {
      const amount = Math.round(input.amount as number);
      const comment = (input.comment as string) || undefined;

      if (!Number.isFinite(amount) || amount <= 0) {
        return JSON.stringify({
          error: 'invalid_amount',
          message: 'Сумма дохода должна быть положительной.',
        });
      }

      await insertTransaction({
        user_id: userId,
        category_id: null,
        type: 'income',
        amount,
        comment,
        source: 'telegram',
        transaction_date: todayAlmaty(),
      });

      const { year, month } = currentMonthAlmaty();
      const summary = await getMonthSummary(year, month);
      const balance = summary.total_income - summary.total_actual;

      let response = `💰 Доход записан: ${formatTenge(amount)}`;
      if (comment) response += ` (${comment})`;
      response += `\n\n📥 Доход за ${monthNameRu(month)}: ${formatTenge(summary.total_income)}`;
      response += `\n📤 Расходы: ${formatTenge(summary.total_actual)}`;
      response += `\n💼 Баланс: ${balance >= 0 ? '+' : ''}${formatTenge(balance)}`;
      return response;
    }

    case 'record_debt': {
      const amount = Math.round(input.amount as number);
      const name = (input.name as string);

      if (!Number.isFinite(amount) || amount <= 0) {
        return JSON.stringify({ error: 'invalid_amount', message: 'Сумма долга должна быть положительной.' });
      }
      if (!name) {
        return JSON.stringify({ error: 'missing_name', message: 'Укажи имя кредитора.' });
      }

      const debt = await addDebt(name, amount);
      const allDebts = await getActiveDebts();
      const totalDebt = allDebts.reduce((s, d) => s + d.remaining_amount, 0);

      let response = `📝 Долг записан: ${formatTenge(amount)} (${debt.name})`;
      response += `\nОстаток по этому долгу: ${formatTenge(debt.remaining_amount)}`;
      response += `\n\n💳 Всего долгов: ${formatTenge(totalDebt)}`;
      for (const d of allDebts) {
        response += `\n- ${d.name}: ${formatTenge(d.remaining_amount)}`;
      }
      return response;
    }

    case 'get_debts': {
      const debts = await getActiveDebts();
      if (debts.length === 0) {
        return '🎉 Нет активных долгов!';
      }

      const totalDebt = debts.reduce((s, d) => s + d.remaining_amount, 0);
      const totalOriginal = debts.reduce((s, d) => s + d.original_amount, 0);
      const paidOff = totalOriginal - totalDebt;
      const pct = totalOriginal > 0 ? Math.round((paidOff / totalOriginal) * 100) : 0;

      let response = `💳 Долги — ${formatTenge(totalDebt)} осталось`;
      response += `\n📊 Погашено ${formatTenge(paidOff)} из ${formatTenge(totalOriginal)} (${pct}%)`;
      response += '\n';
      for (const d of debts) {
        const dPct = d.original_amount > 0 ? Math.round(((d.original_amount - d.remaining_amount) / d.original_amount) * 100) : 0;
        response += `\n- ${d.name}: ${formatTenge(d.remaining_amount)} ост. (${dPct}% погашено)`;
      }
      return response;
    }

    default:
      return JSON.stringify({ error: 'Unknown tool' });
  }
}

export async function chat(
  userMessage: string,
  telegramId: number,
  userName: string,
  chatId: number
): Promise<string> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return '⛔ Пользователь не найден в системе.';

  // Load conversation history (clean text pairs only)
  let history: { role: string; content: string }[] = [];
  try {
    history = await getRecentMessages(chatId, 10);
  } catch {
    // Table may not exist yet — continue without history
  }

  // Build messages array from history, dropping any dangling trailing user message
  // (happens if previous turn errored before the assistant reply was saved)
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of history) {
    // Skip if messages would start with assistant
    if (messages.length === 0 && msg.role === 'assistant') continue;
    // Skip duplicates to maintain alternation
    if (messages.length > 0 && messages[messages.length - 1].role === msg.role) continue;
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }
  // Drop dangling trailing user message (no assistant reply saved for it)
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages.pop();
  }

  // Add current user message
  messages.push({ role: 'user', content: `[${userName}]: ${userMessage}` });
  try { await saveMessage(chatId, 'user', `[${userName}]: ${userMessage}`); } catch { /* */ }

  // Tool-use loop: track final reply across iterations, save ONCE at the end
  let finalReply = '';

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');
    const turnText = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n').trim();
    if (turnText) finalReply = turnText;

    // No tool calls — Claude is done
    if (toolUses.length === 0) break;

    // Push assistant turn + tool results for next iteration (in-memory only)
    messages.push({ role: 'assistant', content: response.content });
    const toolResults: ToolResult[] = [];
    for (const block of toolUses) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input as Record<string, unknown>, user.id);
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

  // Save ONLY the final text reply (no tool_use blocks ever persisted)
  try { await saveMessage(chatId, 'assistant', finalReply); } catch { /* */ }
  return finalReply;
}
