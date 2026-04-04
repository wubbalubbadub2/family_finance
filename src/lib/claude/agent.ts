import Anthropic from '@anthropic-ai/sdk';
import type { CategorySlug } from '@/types';
import {
  getUserByTelegramId,
  getCategories,
  getCategoryBySlug,
  insertTransaction,
  softDeleteTransaction,
  getLastTransaction,
  getLastNTransactions,
  getMonthSummary,
  upsertMonthlyPlan,
  getRecentMessages,
  saveMessage,
} from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, monthNameRu } from '@/lib/utils';

const client = new Anthropic();

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

Правила:
1. Когда пользователь пишет расход (напр. "такси 2500", "кофе 1800") — ВСЕГДА используй tool record_expense
2. Когда спрашивают про бюджет, расходы, план — используй get_month_summary
3. Когда просят показать транзакции — используй get_recent_transactions
4. Когда просят удалить/отменить — используй undo_last
5. Когда просят установить план/бюджет — используй set_plan
6. Отвечай кратко, используй emoji. Суммы всегда в тенге.
7. Если непонятно что хочет пользователь — переспроси, не гадай.
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

      const { year, month } = currentMonthAlmaty();
      const summary = await getMonthSummary(year, month);
      const catSummary = summary.categories.find((c: { category: { id: number } }) => c.category.id === category.id);

      return JSON.stringify({
        success: true,
        category_name: category.name,
        category_emoji: category.emoji,
        amount,
        comment,
        plan: catSummary?.planned ?? 0,
        spent: catSummary?.actual ?? 0,
        remaining: catSummary?.remaining ?? 0,
        percentage: catSummary?.percentage ?? 0,
      });
    }

    case 'get_month_summary': {
      const year = input.year as number;
      const mo = input.month as number;
      const summary = await getMonthSummary(year, mo);

      const cats = summary.categories
        .filter((c: { actual: number; planned: number }) => c.actual > 0 || c.planned > 0)
        .map((c: { category: { emoji: string; name: string }; actual: number; planned: number; percentage: number; remaining: number }) => ({
          emoji: c.category.emoji,
          name: c.category.name,
          actual: c.actual,
          planned: c.planned,
          percentage: c.percentage,
          remaining: c.remaining,
        }));

      return JSON.stringify({
        month: monthNameRu(mo),
        year,
        total_actual: summary.total_actual,
        total_planned: summary.total_planned,
        total_remaining: summary.total_remaining,
        total_income: summary.total_income,
        days_elapsed: summary.days_elapsed,
        days_in_month: summary.days_in_month,
        categories: cats,
      });
    }

    case 'get_recent_transactions': {
      const count = Math.min((input.count as number) || 10, 20);
      const txns = await getLastNTransactions(userId, count, true);
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

  // Load conversation history (gracefully handle missing table)
  let history: { role: string; content: string }[] = [];
  try {
    history = await getRecentMessages(chatId, 10);
  } catch {
    // Table may not exist yet — continue without history
  }

  const messages: Anthropic.MessageParam[] = [];

  // Add previous messages, ensuring proper alternation (user/assistant/user/...)
  let lastRole = '';
  for (const msg of history) {
    if (msg.role === lastRole) continue; // skip duplicates to maintain alternation
    if (messages.length === 0 && msg.role === 'assistant') continue; // must start with user
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    lastRole = msg.role;
  }

  // If last message in history is 'user', add a placeholder assistant to maintain alternation
  if (lastRole === 'user') {
    messages.push({ role: 'assistant', content: 'Понял, продолжаем.' });
  }

  // Add current message
  messages.push({ role: 'user', content: `[${userName}]: ${userMessage}` });

  // Save user message to memory (ignore errors)
  try { await saveMessage(chatId, 'user', `[${userName}]: ${userMessage}`); } catch { /* */ }

  // Loop: Claude may call multiple tools before giving final answer
  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    // If no tool calls, return and save the text response
    if (toolUses.length === 0) {
      const reply = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n').trim() || '🤔';
      try { await saveMessage(chatId, 'assistant', reply); } catch { /* */ }
      return reply;
    }

    // Execute all tool calls
    const toolResults: ToolResult[] = [];
    for (const block of toolUses) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input as Record<string, unknown>, user.id);
        toolResults.push({ tool_use_id: block.id, content: result });
      }
    }

    // Add assistant response + tool results to conversation
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
      })),
    });

    if (response.stop_reason === 'end_turn') {
      const text = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n').trim();
      if (text) {
        try { await saveMessage(chatId, 'assistant', text); } catch { /* */ }
        return text;
      }
    }
  }

  return '⏳ Слишком сложный запрос, попробуйте проще.';
}
