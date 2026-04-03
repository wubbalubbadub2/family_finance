import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { parseExpenseWithRegex } from './regex-parser';
import { parseExpenseWithClaude } from '@/lib/claude/parse-expense';
import {
  getUserByTelegramId,
  getCategories,
  getCategoryBySlug,
  insertTransaction,
  softDeleteTransaction,
  getLastTransaction,
  getLastNTransactions,
  getMonthTransactions,
  getMonthSummary,
} from '@/lib/db/queries';
import { formatTenge, todayAlmaty, currentMonthAlmaty, formatDateShort, monthNameRu } from '@/lib/utils';
import type { Category, ParsedExpense } from '@/types';

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS ?? '')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

// In-memory store for pending categorizations (callback queries)
const pendingExpenses = new Map<string, { amount: number; comment: string | null; userId: string }>();

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Bot(token);

  // Whitelist middleware
  bot.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !ALLOWED_IDS.includes(telegramId)) {
      await ctx.reply('⛔ Доступ запрещён.');
      return;
    }
    await next();
  });

  // Commands
  bot.command('start', handleStart);
  bot.command('today', handleToday);
  bot.command('week', handleWeek);
  bot.command('month', handleMonth);
  bot.command('last', handleLast);
  bot.command('undo', handleUndo);

  // Callback queries (category selection buttons)
  bot.on('callback_query:data', handleCategoryCallback);

  // Free-form text messages (expense input)
  bot.on('message:text', handleTextMessage);

  return bot;
}

async function handleStart(ctx: Context) {
  await ctx.reply(
    '👋 Привет! Я семейный бюджет-бот.\n\n' +
    'Просто напиши расход, например:\n' +
    '• такси 2500\n' +
    '• кофе 1800\n' +
    '• продукты 8400\n\n' +
    'Команды:\n' +
    '/today — расходы за сегодня\n' +
    '/week — расходы за 7 дней\n' +
    '/month — итог месяца\n' +
    '/last — последние 5 транзакций\n' +
    '/undo — удалить последнюю запись'
  );
}

async function handleTextMessage(ctx: Context) {
  const text = ctx.message?.text;
  const telegramId = ctx.from?.id;
  if (!text || !telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  // Tier 1: Try regex parser
  let parsed = parseExpenseWithRegex(text);

  // Tier 2: If regex fails or low confidence, use Claude
  if (!parsed || parsed.confidence < 0.8) {
    const claudeResult = await parseExpenseWithClaude(text);
    if (claudeResult) {
      // Use Claude result if it's more confident
      if (!parsed || claudeResult.confidence > parsed.confidence) {
        parsed = claudeResult;
      }
    }
  }

  if (!parsed) {
    await ctx.reply('🤔 Не удалось распознать расход. Напиши в формате: "кофе 1800"');
    return;
  }

  // If low confidence, ask user to pick category
  if (parsed.confidence < 0.8) {
    const categories = await getCategories();
    const keyboard = new InlineKeyboard();

    // Build a 2-column grid of category buttons
    const key = `${ctx.from.id}_${Date.now()}`;
    pendingExpenses.set(key, {
      amount: parsed.amount,
      comment: parsed.comment,
      userId: user.id,
    });

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      keyboard.text(`${cat.emoji} ${cat.name}`, `cat:${key}:${cat.slug}`);
      if (i % 2 === 1) keyboard.row();
    }

    await ctx.reply(
      `Куда записать ${formatTenge(parsed.amount)}?`,
      { reply_markup: keyboard }
    );
    return;
  }

  // High confidence — record directly
  await recordExpense(ctx, user.id, parsed);
}

async function handleCategoryCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('cat:')) return;

  const parts = data.split(':');
  if (parts.length !== 3) return;

  const [, key, slug] = parts;
  const pending = pendingExpenses.get(key);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Истекло. Введите расход заново.' });
    return;
  }

  pendingExpenses.delete(key);

  const parsed: ParsedExpense = {
    amount: pending.amount,
    category_slug: slug as ParsedExpense['category_slug'],
    comment: pending.comment,
    confidence: 1.0,
  };

  await recordExpense(ctx, pending.userId, parsed);
  await ctx.answerCallbackQuery();
}

async function recordExpense(ctx: Context, userId: string, parsed: ParsedExpense) {
  const category = await getCategoryBySlug(parsed.category_slug);
  if (!category) {
    await ctx.reply('❌ Категория не найдена.');
    return;
  }

  const tx = await insertTransaction({
    user_id: userId,
    category_id: category.id,
    type: 'expense',
    amount: parsed.amount,
    comment: parsed.comment ?? undefined,
    source: 'telegram',
    transaction_date: todayAlmaty(),
  });

  // Get month summary for this category
  const { year, month } = currentMonthAlmaty();
  const summary = await getMonthSummary(year, month);
  const catSummary = summary.categories.find(c => c.category.id === category.id);

  let reply = `✅ Записано\n${category.emoji} ${category.name} — ${formatTenge(parsed.amount)}`;
  if (parsed.comment) reply += `\n💬 ${parsed.comment}`;

  if (catSummary && catSummary.planned > 0) {
    reply += `\n\nОстаток по статье: ${formatTenge(catSummary.remaining)} / ${formatTenge(catSummary.planned)}`;
    if (catSummary.percentage >= 100) {
      reply += '\n🔴 Бюджет превышен!';
    } else if (catSummary.percentage >= 80) {
      reply += `\n⚠️ Использовано ${catSummary.percentage}%`;
    }
  }

  await ctx.reply(reply);
}

async function handleToday(ctx: Context) {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) return;

  const today = todayAlmaty();
  const transactions = (await getMonthTransactions(
    parseInt(today.slice(0, 4)),
    parseInt(today.slice(5, 7))
  )).filter(t => t.transaction_date === today && t.type === 'expense');

  if (transactions.length === 0) {
    await ctx.reply('📭 Сегодня расходов нет.');
    return;
  }

  const categories = await getCategories();
  const catMap = new Map(categories.map(c => [c.id, c]));

  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const lines = transactions.map(t => {
    const cat = t.category_id ? catMap.get(t.category_id) : null;
    return `${cat?.emoji ?? '❓'} ${formatTenge(t.amount)}${t.comment ? ` — ${t.comment}` : ''}`;
  });

  await ctx.reply(`📅 Сегодня (${formatDateShort(today)}):\n\n${lines.join('\n')}\n\n💰 Итого: ${formatTenge(total)}`);
}

async function handleWeek(ctx: Context) {
  const today = new Date(todayAlmaty());
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);

  const startDate = weekAgo.toISOString().split('T')[0];
  const endDate = todayAlmaty();

  const transactions = (await getMonthTransactions(
    today.getFullYear(),
    today.getMonth() + 1
  )).filter(t =>
    t.transaction_date >= startDate &&
    t.transaction_date <= endDate &&
    t.type === 'expense'
  );

  if (transactions.length === 0) {
    await ctx.reply('📭 За неделю расходов нет.');
    return;
  }

  const categories = await getCategories();
  const catMap = new Map(categories.map(c => [c.id, c]));

  // Group by category
  const byCategory = new Map<number, number>();
  for (const t of transactions) {
    if (t.category_id) {
      byCategory.set(t.category_id, (byCategory.get(t.category_id) ?? 0) + t.amount);
    }
  }

  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const lines = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([catId, amount]) => {
      const cat = catMap.get(catId);
      return `${cat?.emoji ?? '❓'} ${cat?.name ?? '?'}: ${formatTenge(amount)}`;
    });

  await ctx.reply(
    `📊 За 7 дней (${formatDateShort(startDate)} – ${formatDateShort(endDate)}):\n\n${lines.join('\n')}\n\n💰 Итого: ${formatTenge(total)}`
  );
}

async function handleMonth(ctx: Context) {
  const { year, month } = currentMonthAlmaty();
  const summary = await getMonthSummary(year, month);

  const lines = summary.categories
    .filter(c => c.actual > 0 || c.planned > 0)
    .map(c => {
      let line = `${c.category.emoji} ${c.category.name}: ${formatTenge(c.actual)}`;
      if (c.planned > 0) {
        line += ` / ${formatTenge(c.planned)} (${c.percentage}%)`;
      }
      return line;
    });

  let header = `📊 ${monthNameRu(month)} ${year}\n`;
  header += `День ${summary.days_elapsed} из ${summary.days_in_month}\n\n`;

  if (summary.total_income > 0) {
    header += `📥 Доход: ${formatTenge(summary.total_income)}\n`;
  }
  header += `📤 Расходы: ${formatTenge(summary.total_actual)}`;
  if (summary.total_planned > 0) {
    header += ` / ${formatTenge(summary.total_planned)}`;
  }
  header += '\n';

  if (summary.total_income > 0) {
    const net = summary.total_income - summary.total_actual;
    header += `${net >= 0 ? '✅' : '🔴'} Баланс: ${formatTenge(net)}\n`;
  }

  await ctx.reply(`${header}\n${lines.join('\n')}`);
}

async function handleLast(ctx: Context) {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) return;

  const transactions = await getLastNTransactions(user.id, 5);
  if (transactions.length === 0) {
    await ctx.reply('📭 Транзакций пока нет.');
    return;
  }

  const categories = await getCategories();
  const catMap = new Map(categories.map(c => [c.id, c]));

  const lines = transactions.map(t => {
    const cat = t.category_id ? catMap.get(t.category_id) : null;
    const typeIcon = t.type === 'income' ? '📥' : (cat?.emoji ?? '❓');
    return `${formatDateShort(t.transaction_date)} ${typeIcon} ${formatTenge(t.amount)}${t.comment ? ` — ${t.comment}` : ''}`;
  });

  await ctx.reply(`📋 Последние 5:\n\n${lines.join('\n')}`);
}

async function handleUndo(ctx: Context) {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) return;

  const last = await getLastTransaction(user.id);
  if (!last) {
    await ctx.reply('📭 Нечего удалять.');
    return;
  }

  const categories = await getCategories();
  const cat = categories.find(c => c.id === last.category_id);

  await softDeleteTransaction(last.id);
  await ctx.reply(
    `🗑️ Удалено: ${cat?.emoji ?? ''} ${formatTenge(last.amount)}${last.comment ? ` — ${last.comment}` : ''}`
  );
}
