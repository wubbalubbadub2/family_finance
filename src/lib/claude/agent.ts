import Anthropic from '@anthropic-ai/sdk';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Category } from '@/types';
import {
  getUserByTelegramId,
  getCategoriesForFamily,
  getCategoryBySlugInFamily,
  insertTransaction,
  softDeleteTransaction,
  getLastTransaction,
  getMonthSummary,
  getRecentMessages,
  saveMessage,
  addDebt,
  payDebt,
  getActiveDebts,
  lookupCategoryOverride,
  getActiveGoal,
  searchTransactionsByComment,
  listRecentTransactionsPaged,
  setPendingListContext,
  clearPendingListContext,
  setPendingConfirm,
  getPendingConfirm,
  clearPendingConfirm,
  generateConfirmNonce,
  createGoal,
  archiveGoal,
  addGoalContribution,
  createCategory,
  createCategoriesBulk,
  renameCategory,
  deleteCategory,
  mergeCategories,
  upsertMonthlyPlan,
  updateTransactionCategory,
  upsertCategoryOverride,
  resolveTransactionRef,
  topItemsByComment,
  resolveCategoryByName,
  findRecentDuplicate,
  type ConfirmType,
  type PendingConfirm,
} from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, monthNameRu, formatTenge } from '@/lib/utils';
import { renderGoalProgress } from '@/lib/goals';
import {
  stripCurrencyMarkers,
  tryParseExpenses,
  tryParseIncome,
  tryParseDebt,
  isUndoRequest,
  isMeaningfulInput,
} from '@/lib/parsers';

// Re-export for any historical callers that imported from this module.
export { stripCurrencyMarkers, tryParseExpenses, tryParseIncome, tryParseDebt, isUndoRequest };

const client = new Anthropic();
// Sonnet 4.6 for tool routing — Haiku had ~15-30% miss rate on ambiguous
// Russian phrasing even with aggressive prompts. Sonnet is ~5× more per call
// but at 1-2 families scale, that's pennies/month and the reliability wins.
// Override via env if you want to test Haiku or a different model.
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ═══════════════════════════════════════════════════════════════
// PATTERN DETECTION — determine user intent from text
// ═══════════════════════════════════════════════════════════════

// Pattern detection moved to src/lib/parsers.ts so unit tests can import the
// pure functions without bootstrapping Anthropic + Supabase clients.

// ═══════════════════════════════════════════════════════════════
// Family context — carried through every handler so we never leak
// cross-family data. Resolved once per webhook at the top of chat().
// ═══════════════════════════════════════════════════════════════

interface FamilyCtx {
  familyId: string;
  userId: string;
  userName: string;
  chatId: number;
}

// ═══════════════════════════════════════════════════════════════
// BotResponse — the shape chat() returns. Optional inline keyboard
// lets write-tool proposals render confirm/cancel buttons.
// ═══════════════════════════════════════════════════════════════

export interface BotResponse {
  text: string;
  keyboard?: InlineKeyboardButton[][];
}

function textOnly(text: string): BotResponse {
  return { text };
}

function withKeyboard(text: string, keyboard: InlineKeyboardButton[][]): BotResponse {
  return { text, keyboard };
}

function confirmKeyboard(nonce: string): InlineKeyboardButton[][] {
  return [[
    { text: '✅ Да', callback_data: `confirm:${nonce}` },
    { text: '❌ Отмена', callback_data: `cancel:${nonce}` },
  ]];
}

// ═══════════════════════════════════════════════════════════════
// DETERMINISTIC DB HANDLERS — no hallucination possible
// ═══════════════════════════════════════════════════════════════

/**
 * Family-aware categorization. Two-tier routing:
 *   1. Check per-family category_overrides table FIRST (deterministic, no LLM).
 *      If 'чипсы' has been corrected to 'food' for this family, any expense
 *      mentioning 'чипсы' routes to 'food' without asking Haiku. This fixes
 *      the reliability issue where same keyword gets different categories.
 *   2. Fall back to Haiku — but prompt it with the family's ACTUAL category
 *      list (not a hardcoded one). Supports custom categories from create_category.
 *
 * Returns a slug that exists in the family's category list. Falls back to
 * 'misc' if present, otherwise the first available category's slug.
 */
async function categorize(description: string, familyCategories: Category[], familyId: string): Promise<string> {
  // Tier 1: family-level override (deterministic consistency)
  const override = await lookupCategoryOverride(familyId, description);
  if (override && familyCategories.some(c => c.slug === override)) {
    return override;
  }

  // Tier 2: ask Haiku, but with this family's categories only
  const slugList = familyCategories.map(c => c.slug);
  const slugListStr = slugList.join(', ');
  const fallback = slugList.includes('misc') ? 'misc' : slugList[0] ?? 'misc';

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 50,
      system: `Определи категорию расхода. Верни ТОЛЬКО slug из этого списка: ${slugListStr}`,
      messages: [{ role: 'user', content: description }],
    });
    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim().toLowerCase() : '';
    if (slugList.includes(text)) return text;
  } catch { /* fallback */ }
  return fallback;
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
  ctx: FamilyCtx,
): Promise<string> {
  const results: string[] = [];
  const errors: string[] = [];

  // Fetch once per request to drive categorizer prompt + slug→id resolution
  const familyCategories = await getCategoriesForFamily(ctx.familyId);

  for (const exp of expenses) {
    // Dedup guard: reject a second identical row within 10 min. Catches the
    // bot-retry / double-tap pattern that polluted April with ~6 duplicates
    // before we noticed. Legitimate repeat entries (morning + evening bus,
    // two coffees in a day) sit outside the window so they still log.
    const dupe = await findRecentDuplicate({
      familyId: ctx.familyId,
      amount: exp.amount,
      comment: exp.description,
    }).catch(() => null);
    if (dupe) {
      const ageMin = Math.max(1, Math.round((Date.now() - new Date(dupe.created_at).getTime()) / 60_000));
      results.push(`⏭️ ${formatTenge(exp.amount)} (${exp.description}) — пропущено, дубликат записи ${ageMin} мин назад. Если это отдельная трата — добавь уточнение: «${exp.description} 2 ${exp.amount}».`);
      continue;
    }

    const slug = await categorize(exp.description, familyCategories, ctx.familyId);
    const category = familyCategories.find(c => c.slug === slug) ?? await getCategoryBySlugInFamily(slug, ctx.familyId);
    if (!category) { errors.push(`❌ ${exp.description}: категория не найдена`); continue; }

    try {
      await insertTransaction({
        family_id: ctx.familyId,
        user_id: ctx.userId,
        category_id: category.id,
        type: 'expense',
        amount: exp.amount,
        comment: exp.description,
        source: 'telegram',
        transaction_date: todayAlmaty(),
      });

      let extra = '';
      // 'credit' slug is still semantically meaningful as a debt category —
      // but only if the family has that slug (they might have renamed or deleted it).
      if (slug === 'credit') {
        const debt = await payDebt(exp.description, exp.amount, ctx.familyId);
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
  const summary = await getMonthSummary(year, month, ctx.familyId);
  let reply = results.concat(errors).join('\n');
  reply += '\n\n' + buildSummaryText(summary);

  // Goal progress line (kill-switch + try/catch wrapped inside renderGoalProgress)
  const goal = await getActiveGoal(ctx.familyId).catch(() => null);
  const goalLine = renderGoalProgress(goal);
  if (goalLine) reply += '\n\n' + goalLine;

  return reply;
}

async function handleIncome(income: { amount: number; comment: string }, ctx: FamilyCtx): Promise<string> {
  try {
    await insertTransaction({
      family_id: ctx.familyId,
      user_id: ctx.userId,
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
  const summary = await getMonthSummary(year, month, ctx.familyId);
  const balance = summary.total_income - summary.total_actual;

  let reply = `💰 Доход записан: ${formatTenge(income.amount)} (${income.comment})`;
  reply += `\n\n📥 Доход за ${monthNameRu(month)}: ${formatTenge(summary.total_income)}`;
  reply += `\n📤 Расходы: ${formatTenge(summary.total_actual)}`;
  reply += `\n💼 Баланс: ${balance >= 0 ? '+' : ''}${formatTenge(balance)}`;
  return reply;
}

async function handleDebt(debt: { amount: number; name: string }, ctx: FamilyCtx): Promise<string> {
  try {
    const d = await addDebt(debt.name, debt.amount, ctx.familyId);
    const allDebts = await getActiveDebts(ctx.familyId);
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

/**
 * Heuristic: does this comment look like a multi-item / bundled purchase?
 * When true, attributing the FULL amount to the search keyword is misleading
 * (e.g., "Ферровит с и агуша" for 7 139 ₸ — half was Ферровит).
 *
 * Signals:
 *   - Contains ` и ` or `, ` or ` + ` → multiple items joined
 *   - Contains `/` or ` с ` (Russian "with") → probably a combo
 *   - ≥ 3 whitespace-separated tokens → description that's more than a single noun
 *
 * False positives are OK ("Лента универсам" gets flagged as multi-item) —
 * the footer warning is advisory, not restrictive.
 */
function commentLooksBundled(comment: string, keyword: string): boolean {
  const trimmed = comment.trim();
  if (!trimmed) return false;
  if (/[,\/+]/.test(trimmed)) return true;
  if (/\s+и\s+/.test(trimmed)) return true;
  if (/\s+с\s+/.test(trimmed)) return true;
  // 3+ non-trivial tokens, at least one not containing the search keyword
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  if (tokens.length >= 3) {
    const kwLower = keyword.toLowerCase();
    const nonKwTokens = tokens.filter(t => !t.includes(kwLower));
    if (nonKwTokens.length >= 2) return true;
  }
  return false;
}

function formatSearchReply(
  result: { sum: number; count: number; sample: import('@/types').Transaction[]; effectiveKeyword?: string },
  args: { keyword: string; periodStart?: string; periodEnd?: string },
  categories: import('@/types').Category[],
): string {
  // When server-side stemming kicks in (e.g., user asked "агушу" but we found
  // results with stem "агуш"), note the effective keyword in the header so
  // the user understands what we matched.
  const matchedWord = result.effectiveKeyword && result.effectiveKeyword !== args.keyword
    ? `${args.keyword} (искал как '${result.effectiveKeyword}')`
    : args.keyword;

  if (result.count === 0) {
    const periodHint = args.periodStart || args.periodEnd ? ` за указанный период` : '';
    return `🔍 По '${matchedWord}'${periodHint} — ничего не найдено.`;
  }

  const catMap = new Map(categories.map(c => [c.id, c]));

  let text = `🔍 По '${matchedWord}'`;
  if (args.periodStart || args.periodEnd) {
    text += ` (${args.periodStart ?? '...'} → ${args.periodEnd ?? '...'})`;
  }

  if (result.count <= result.sample.length) {
    text += `: *${formatTenge(result.sum)}* · ${result.count} трат\n\n`;
  } else {
    text += `: найдено ${result.count} трат. Показываю последние ${result.sample.length} на сумму *${formatTenge(result.sum)}*\n\n`;
  }

  // Rows — always show the comment verbatim; flag multi-item lines with 📎
  // so users can tell their search keyword was one of several items.
  let bundledCount = 0;
  for (const t of result.sample) {
    const cat = t.category_id ? catMap.get(t.category_id) : null;
    const icon = cat?.emoji ?? '❓';
    const bundled = t.comment ? commentLooksBundled(t.comment, args.keyword) : false;
    if (bundled) bundledCount++;
    text += `${t.transaction_date} | ${icon} ${formatTenge(t.amount)}`;
    if (t.comment) text += ` — ${bundled ? '📎 ' : ''}${t.comment}`;
    text += '\n';
  }

  if (bundledCount > 0) {
    text += `\n⚠️ ${bundledCount} ${bundledCount === 1 ? 'покупка содержит' : 'покупок содержат'} несколько позиций (📎). `;
    text += `Реальная сумма только по '${args.keyword}' может быть меньше *${formatTenge(result.sum)}*.`;
  }

  return text.trim();
}

async function handleUndo(ctx: FamilyCtx): Promise<string> {
  const last = await getLastTransaction(ctx.userId, ctx.familyId);
  if (!last) return '📭 Нет транзакций для удаления.';

  const categories = await getCategoriesForFamily(ctx.familyId);
  const cat = categories.find(c => c.id === last.category_id);

  try {
    await softDeleteTransaction(last.id, ctx.familyId);
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
    name: 'search_transactions_by_comment',
    description:
      'PRIMARY TOOL for keyword-specific questions — "how much on X", "when did we buy X", ' +
      '"how many times did we purchase X", "дай расходы на X". Searches ALL transaction history ' +
      '(not just recent), sums matching amounts, returns count + sample.\n\n' +
      'WHEN TO USE:\n' +
      '  "сколько на чипсы?" → keyword="чипсы"\n' +
      '  "сколько потратили на агушу?" → keyword="агуша" (use nominative/base form when possible)\n' +
      '  "дай расходы на агушу" → keyword="агуша" (strip "дай расходы на" prefix)\n' +
      '  "сколько раз мы покупали кофе?" → keyword="кофе"\n' +
      '  "сколько на кафе в апреле?" → keyword="кафе", period_start="2026-04-01", period_end="2026-04-30"\n' +
      '  "how much on taxi this month?" → keyword="taxi", period_start=<first of month>\n\n' +
      'KEYWORD EXTRACTION RULES (important for Russian):\n' +
      '  • Use the NOUN the user asked about. Strip verbs ("потратили", "купили"), ' +
      'question words ("сколько", "как"), prepositions ("на", "за"), pronouns ("мы", "я"), ' +
      'and request verbs ("дай", "покажи", "give me").\n' +
      '  • Prefer the nominative/base form (e.g., "агуша" not "агушу", "чипсы" not "чипсов"). ' +
      'The server applies Russian morphology stemming as a safety net, but base form gives best results.\n' +
      '  • ILIKE does case-insensitive substring match — "агуш" catches "агуша", "агуши", "агушей", etc.\n\n' +
      'DO NOT use list_recent_transactions for keyword questions — list only sees the last N rows. ' +
      'If the user mentions a specific product/service by name, THIS is the tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Base form of the noun the user is asking about. Examples: "агуша", "чипсы", "кофе", "такси", "groceries". Lowercased automatically.' },
        period_start: { type: 'string', description: 'YYYY-MM-DD (inclusive). Omit for all time.' },
        period_end: { type: 'string', description: 'YYYY-MM-DD (inclusive). Omit for all time.' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_month_summary',
    description: 'Get the current-month category-by-category budget summary. Use for "how is the budget?", ' +
      '"что у нас с бюджетом", "show me the month". NOT for keyword-specific questions (use search instead).',
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
    name: 'list_recent_transactions',
    description:
      'List transactions chronologically, newest first, with pagination support. ' +
      'Use when user asks to SEE a list without specifying a product/keyword — e.g., ' +
      '"покажи последние 20 транзакций", "show me recent expenses", "что мы тратили вчера?", ' +
      '"last 10 transactions". ' +
      'For pagination: if user says "ещё" or "more", call again with offset = previous_offset + previous_limit. ' +
      'For time windows, pass period_start and period_end as YYYY-MM-DD (e.g., April 2026 = 2026-04-01..2026-04-30). ' +
      'Hard cap 30 items per reply (Telegram message length). ' +
      'DO NOT use this for "сколько на X" / "сколько мы потратили на X" — those go to search_transactions_by_comment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max 30. Default 10.' },
        offset: { type: 'number', description: 'For pagination. 0 = latest.' },
        period_start: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for all time.' },
        period_end: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for all time.' },
      },
      required: [],
    },
  },
  {
    name: 'get_top_items_by_comment',
    description:
      'Return the top N items (by total spent) grouped by transaction comment. ' +
      'Use when user asks "на что больше всего потратили (САМ ЭЛЕМЕНТ, не категория)?", ' +
      '"what did we spend the most on?", "топ-10 трат по товарам", "на какие товары больше всего ушло?". ' +
      'Different from get_month_summary (which groups by category) — this groups by the specific item/comment. ' +
      'Lowercased same-comment entries merge ("Агуша" + "агуша" → one row). ' +
      'For "за апрель" / "за неделю" etc., pass period_start + period_end as YYYY-MM-DD.\n\n' +
      'CATEGORY DRILL-DOWN: pass `category` to list ALL items inside a single category. ' +
      'This is the right tool for "из чего состоит Разное?", "что в категории Продукты?", ' +
      '"что входит в Кафе?", "breakdown of X category". Pair with period + a high limit ' +
      '(e.g. 50) to get the full composition. The category arg is fuzzy — "Разное", "разное", ' +
      '"раз" all match "Разное 🎲".',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'How many top items to return. Default 10, max 50. Use 50 for category drill-down to get everything.' },
        period_start: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for all time.' },
        period_end: { type: 'string', description: 'YYYY-MM-DD inclusive. Omit for all time.' },
        category: { type: 'string', description: 'Optional. Category name (e.g. "Разное"). When set, only items in that category are listed/aggregated.' },
      },
      required: [],
    },
  },
  {
    name: 'get_debts',
    description: 'Show active debts (deterministic list with totals + per-debt remaining).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

/**
 * Quick response for first-run users who try to log expenses before creating
 * any categories. Echo back what they wrote so they know we saw it, then
 * guide to the setup step.
 */
function firstRunWelcomeExpenseAttempt(expenses: { amount: number; description: string }[]): string {
  let reply = '👋 Добро пожаловать! Прежде чем записывать траты, создай свои категории расходов.\n\n';
  reply += 'Напиши, например:\n';
  reply += '*"создай категории: Продукты 🛒, Транспорт 🚗, Кафе ☕, Жильё 🏠, Личное 🎯, Прочее 🎲"*\n\n';
  reply += 'Бот предложит создать их все одной кнопкой ✅ Да.\n\n';
  reply += 'После этого я смогу записать:\n';
  for (const e of expenses.slice(0, 3)) {
    reply += `- ${e.description} ${e.amount} ₸\n`;
  }
  return reply;
}

function buildSystemPrompt(firstRun = false): string {
  const { year, month } = currentMonthAlmaty();
  const today = todayAlmaty();

  const firstRunBlock = firstRun ? `
⚠️ FIRST RUN: у этой семьи НЕТ категорий. Что бы пользователь ни спрашивал —
СНАЧАЛА предложи создать стартовый набор категорий. Используй
propose_create_categories_bulk со списком из 6-8 типичных категорий
(Продукты 🛒, Транспорт 🚗, Кафе ☕, Жильё 🏠, Здоровье 💊, Личное 🎯, Прочее 🎲),
либо персонализированный под контекст пользователя. Пока категорий нет,
ничего другого делать не нужно — только онбординг.
` : '';

  return `Ты — семейный финансовый ассистент. Кратко, на русском.

Сегодня: ${today}. Месяц: ${monthNameRu(month)} ${year}.
${firstRunBlock}
У тебя ЕСТЬ инструменты чтения и записи. НЕ отказывайся "я не могу изменить" — если
пользователь просит что-то изменить, найди подходящий propose_* инструмент и вызови
его. Система спросит у пользователя подтверждение.

Новые траты/доходы/долги уже записываются системой автоматически из сумм+описаний
("кофе 1200"). Если пользователь просто пишет сумму и описание — не вмешивайся. Но
если он хочет ИЗМЕНИТЬ уже записанное (поменять категорию, удалить) — это ТВОЯ работа.

🚨 КРИТИЧЕСКОЕ ПРАВИЛО (не нарушать ни при каких условиях):
Если пользовательское сообщение ВЫГЛЯДИТ как трата (что-то + число), но ты
видишь его — значит детерминированный парсер пропустил его (странный формат,
суффикс "тг"/"₸"/"тенге", опечатка). НИКОГДА не отвечай "Записала", "Записано",
"система зафиксирует", "Зафиксировал", или любой формулировкой, подразумевающей
что трата сохранена — потому что у тебя НЕТ инструмента создания транзакций,
и любое такое подтверждение будет ЛОЖЬЮ. Это сломает доверие пользователя к боту.

Вместо этого скажи: "🤔 Не понял формат — напиши проще: «описание сумма» (без 'тг'/'₸').
Например: «Супермаркет 1762» или «1762 супермаркет»." Дай конкретный пример из
сообщения пользователя.

ЧТЕНИЕ:
- search_transactions_by_comment(keyword, period?) — поиск по ключевому слову.
  Используй КОГДА пользователь называет товар/услугу ("сколько на чипсы", "дай расходы на агушу").
  Также используй чтобы НАЙТИ транзакцию по описанию перед её изменением.
  Сервер сам применит русскую морфологию — но ты всё равно передавай базовую форму
  (именительный падеж) если можешь: "агуша" не "агушу", "чипсы" не "чипсов".
- list_recent_transactions(limit?, offset?, period?) — список последних транзакций.
  Используй КОГДА пользователь хочет увидеть список БЕЗ конкретного товара
  ("покажи последние 20", "что мы тратили вчера"). Для "ещё" — передавай offset = предыдущий_offset + предыдущий_limit.
  НЕ используй для вопросов "сколько на X" — там нужен search.
- get_month_summary(year, month) — итоги месяца с разбивкой по КАТЕГОРИЯМ
- get_top_items_by_comment(limit?, period?, category?) — топ ТОВАРОВ/ЭЛЕМЕНТОВ по сумме трат.
  Используй когда пользователь хочет знать "на что больше всего потратили" на уровне
  КОНКРЕТНЫХ ВЕЩЕЙ, не категорий: "на что больше всего ушло?", "топ-10 товаров",
  "на что больше всего потратили — не категория, а сам элемент".
  НЕ get_month_summary — там разбивка по категориям (Продукты, Транспорт и т.д.).
  РАЗБОР КАТЕГОРИИ: "из чего состоит Разное?", "что входит в Продукты?",
  "breakdown of X", "покажи все в категории Y" → передавай category="Y", limit=50,
  period=текущий месяц (если пользователь не указал другой). Это вернёт ВСЕ позиции
  внутри категории в одном сообщении — НЕ предлагай "ещё" и НЕ get_month_summary.
- get_debts — долги

ЗАПИСЬ (пользователь подтверждает кнопкой ✅ Да перед исполнением):
- propose_create_goal(name, target_amount, deadline)
- propose_contribute_to_goal(amount)
- propose_archive_goal()
- propose_delete_transaction(transaction_id)
- propose_update_transaction_category(transaction_id, new_category_slug) ⬅
- propose_set_monthly_plan(category_slug, amount, year?, month?)
- propose_create_category(name, emoji) — одна категория
- propose_create_categories_bulk(categories: [{name, emoji}, ...]) — несколько за раз, одна кнопка ✅ (используй при онбординге)
- propose_rename_category(slug, new_name, new_emoji?)
- propose_delete_category(slug, reassign_to_slug?)
- propose_merge_categories(from_slug, into_slug)

ПОТОК ИЗМЕНЕНИЯ КАТЕГОРИИ ТРАНЗАКЦИИ (важно, часто спрашивают):
Триггеры: "включи X в Y", "перемести X в Y", "переклассифицируй X в Y",
"это было не X а Y", "поменяй категорию X на Y", "put X in Y".
Шаги:
  1. search_transactions_by_comment(keyword=X) — найти последнюю транзакцию с X
  2. propose_update_transaction_category(transaction_id=<id последней>, new_category_slug=<slug Y>)

Категория-slug маппинги по умолчанию (для твоей семьи после миграции 007):
  "жильё/квартира/коммуналка" = home
  "продукты/еда" = food
  "транспорт/такси/бензин" = transport
  "кафе/ресторан/выход" = cafe
  "ребёнок/балапанчик/дети" = baby
  "здоровье/аптека/врач" = health
  "кредит/долг" = credit
  "личное/одежда/стрижка" = personal
  "сбережения/savings/копилка" = savings
  "разное/прочее" = misc
У семьи также могут быть свои категории — используй search_transactions_by_comment
или задай уточняющий вопрос если slug неясен.

ПЕРИОДЫ:
Когда пользователь упоминает период, конвертируй в YYYY-MM-DD:
  "в этом месяце" → period_start = ${year}-${String(month).padStart(2, '0')}-01, period_end = последний день этого месяца
  "в апреле" / "за март" / etc. → period_start + period_end для того месяца ${year} года
  "за неделю" / "на этой неделе" → понедельник—воскресенье этой недели (Asia/Almaty)
  "вчера" → period_start = period_end = вчера (Almaty)
  "сегодня" → period_start = period_end = ${today}
Если период не указан — не передавай period_start/period_end, ищи за всё время.

ПЕРИОДЫ:
Когда в вопросе упомянут месяц/неделя/диапазон, всегда передавай period_start и period_end
в формате YYYY-MM-DD. Примеры:
- "в апреле" → period_start=2026-04-01, period_end=2026-04-30
- "на этой неделе" → period_start=<понедельник>, period_end=<воскресенье>
- "в этом году" → period_start=2026-01-01, period_end=2026-12-31
- без упоминания периода → не передавай, ищи за всё время

КОГДА ПИСАТЬ:
- "хочу накопить N к [даты]" или "создай цель" → propose_create_goal
- "отложил/кинул/добавил N" (без описания расхода) → propose_contribute_to_goal
- "закрой цель" / "забудь цель" → propose_archive_goal
- "удали трату N" (где N — описание) → сначала list_recent_transactions найти её, потом propose_delete_transaction с ID
- "это было не Х, а Y" / "поменяй категорию на Y" / "переклассифицируй в Y" → найди транзакцию через list_recent или search, потом propose_update_transaction_category
- "поставь лимит N на [категорию]" → propose_set_monthly_plan
- "создай категорию X" (одна) → propose_create_category
- "создай категории X, Y, Z" / "добавь 5 категорий" / "стартовый набор" → propose_create_categories_bulk
- "переименуй X в Y" / "поменяй название" → propose_rename_category
- "удали категорию" → propose_delete_category
- "объедини X в Y" → propose_merge_categories

КРИТИЧЕСКИ ВАЖНО: результаты read-tools — ЭТО УЖЕ ГОТОВЫЙ ТЕКСТ для пользователя.
— Выводи ДОСЛОВНО, символ в символ, без изменений.
— НЕ создавай markdown-таблицы (| Дата | Сумма |). Telegram их не рендерит нормально,
  текст становится мусором из столбиков палок.
— НЕ сокращай комментарии транзакций — пользователю важно видеть ПОЛНЫЙ текст
  ("Ферровит с и агуша" означает ДВА товара; если выкинуть — данные искажаются).
— НЕ убирай значки 📎 и ⚠️ из ответов search — они помечают многопозиционные покупки.
— Если тебе очень хочется что-то добавить от себя — добавь коротко В КОНЦЕ, после
  полного результата tool. Сам результат НЕ трогай.
Результаты write-tools обрабатываются системой (показывается кнопка подтверждения пользователю) — тебе после пропозала ничего говорить не нужно.`;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
}

// ═══════════════════════════════════════════════════════════════
// Write tools — Claude proposes, user confirms via inline keyboard
// ═══════════════════════════════════════════════════════════════

const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_create_goal',
    description:
      'Propose creating a new savings goal. Only ONE active goal per family — if user already has one, system will reject. ' +
      'Call when user says "хочу накопить Х к [деадлайну] на [что-то]" or similar. ' +
      'Extract amount (in tenge, integer), deadline (YYYY-MM-DD), and goal name (what they\'re saving for).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Короткое название цели, например "Отпуск 2026" или "Машина"' },
        target_amount: { type: 'number', description: 'Целевая сумма в тенге (целое число)' },
        deadline: { type: 'string', description: 'Дата достижения в формате YYYY-MM-DD' },
      },
      required: ['name', 'target_amount', 'deadline'],
    },
  },
  {
    name: 'propose_contribute_to_goal',
    description:
      'Propose adding money to the active goal. Call when user says "отложил/кинул/добавил N на цель/копилку" or similar. ' +
      'Only works if the family has an active goal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Сумма взноса в тенге (целое, >0)' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'propose_archive_goal',
    description:
      'Propose archiving the active goal (marks it complete/abandoned). ' +
      'Call when user says "закрой цель", "отмени цель", "goal achieved".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'propose_delete_transaction',
    description:
      'Propose deleting a specific transaction. Call when user wants to remove a logged expense ' +
      '(e.g., "удали 3880 курица", "remove the coffee", "удали пиво"). ' +
      'The transaction_id field accepts EITHER a UUID (if you already looked it up) OR a keyword/description ' +
      '(e.g., "пиво", "чипсы"). If you pass a keyword, the server finds the most recent matching expense automatically. ' +
      'You do NOT need to call list_recent_transactions or search first if the user already gave you a clear keyword.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transaction_id: { type: 'string', description: 'UUID OR a keyword from the transaction comment (e.g. "пиво", "кофе"). Server resolves to most recent match.' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'propose_update_transaction_category',
    description:
      'Propose changing the category of a transaction. Call when user says the categorization was wrong: ' +
      '"пиво не продукты, а кафе", "это было Продукты, не Разное", "поменяй категорию чипсов на Продукты", ' +
      '"переклассифицируй пиво в личное". ' +
      'The transaction_id field accepts EITHER a UUID OR a keyword/description. If you pass a keyword like ' +
      '"пиво" or "чипсы", the server finds the most recent matching expense automatically — you do NOT need ' +
      'to call search first. ' +
      'IMPORTANT: on confirm, the system also saves a per-family override keyword→category so future similar ' +
      'expenses auto-route correctly. This is the main mechanism for improving categorization reliability.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transaction_id: { type: 'string', description: 'UUID OR a keyword from the transaction comment (e.g. "пиво", "кофе"). Server resolves to most recent match.' },
        new_category_slug: { type: 'string', description: 'Target category slug from the family list (food, cafe, personal, etc.)' },
      },
      required: ['transaction_id', 'new_category_slug'],
    },
  },
  {
    name: 'propose_set_monthly_plan',
    description:
      'Propose setting a monthly spending limit for a category. ' +
      'Call when user says "поставь лимит Х на Y", "set Y budget to Х", "bu ayn kafeye X tenge".',
    input_schema: {
      type: 'object' as const,
      properties: {
        category_slug: { type: 'string', description: 'Slug of the category (food, transport, cafe, etc.)' },
        amount: { type: 'number', description: 'Planned amount in tenge' },
        year: { type: 'number', description: 'Year (default: current)' },
        month: { type: 'number', description: '1-12 (default: current)' },
      },
      required: ['category_slug', 'amount'],
    },
  },
  {
    name: 'propose_create_category',
    description:
      'Propose creating a SINGLE new category for this family. ' +
      'Call when user says "создай категорию X с эмодзи Y" for one category. ' +
      'For multiple categories at once use propose_create_categories_bulk instead — one confirm tap covers all.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name (e.g., "Чипсы/снеки")' },
        emoji: { type: 'string', description: 'Single emoji for the category' },
      },
      required: ['name', 'emoji'],
    },
  },
  {
    name: 'propose_create_categories_bulk',
    description:
      'Propose creating MULTIPLE categories at once — one confirm covers all. ' +
      'Use for first-run setup ("создай категории Продукты 🛒, Транспорт 🚗, Кафе ☕") ' +
      'and for any message that lists ≥2 categories at once. Pick sensible emojis yourself ' +
      'if the user only provides names.',
    input_schema: {
      type: 'object' as const,
      properties: {
        categories: {
          type: 'array',
          description: 'List of categories to create. Each has name + emoji.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              emoji: { type: 'string' },
            },
            required: ['name', 'emoji'],
          },
        },
      },
      required: ['categories'],
    },
  },
  {
    name: 'propose_rename_category',
    description: 'Propose renaming an existing category. Preserves slug; only name/emoji change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Slug of the category to rename' },
        new_name: { type: 'string' },
        new_emoji: { type: 'string', description: 'Optional new emoji' },
      },
      required: ['slug', 'new_name'],
    },
  },
  {
    name: 'propose_delete_category',
    description:
      'Propose deleting a category. All transactions are reassigned to the target category (default: misc). ' +
      'Call when user says "удали категорию Х".',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Slug of the category to delete' },
        reassign_to_slug: { type: 'string', description: 'Where to move existing transactions. Default "misc".' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'propose_merge_categories',
    description:
      'Propose merging one category into another. All transactions from `from_slug` move to `into_slug`, ' +
      'then source is soft-deleted. Call for "объедини Х в Y" / "merge X into Y".',
    input_schema: {
      type: 'object' as const,
      properties: {
        from_slug: { type: 'string' },
        into_slug: { type: 'string' },
      },
      required: ['from_slug', 'into_slug'],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map(t => t.name));

/**
 * Validate + serialize a write-tool call into a pending_confirm row,
 * then return the confirm message + inline keyboard for the bot to send.
 * Does NOT execute the underlying action — that happens in
 * executeConfirmedAction after the user taps ✅ Да.
 */
async function proposeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FamilyCtx,
): Promise<BotResponse> {
  // Strip "propose_" prefix — stored type is the action name
  const actionType = toolName.replace(/^propose_/, '') as ConfirmType;
  const nonce = generateConfirmNonce();

  // Build a human-readable confirm message based on the action + args
  let message: string;
  try {
    message = await buildProposalMessage(actionType, input, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'неверные аргументы';
    return textOnly(`❌ ${msg}`);
  }

  await setPendingConfirm(ctx.familyId, {
    nonce,
    type: actionType,
    args: input,
  });

  return withKeyboard(message, confirmKeyboard(nonce));
}

async function buildProposalMessage(
  type: ConfirmType,
  input: Record<string, unknown>,
  ctx: FamilyCtx,
): Promise<string> {
  switch (type) {
    case 'create_goal': {
      const name = String(input.name ?? '').trim();
      const target = Number(input.target_amount);
      const deadline = String(input.deadline ?? '');
      if (!name) throw new Error('Укажи название цели.');
      if (!target || target <= 0) throw new Error('Укажи сумму больше 0.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new Error('Дедлайн должен быть в формате YYYY-MM-DD.');
      return `🎯 Создать цель: *${name}* — ${formatTenge(target)} к ${deadline}?`;
    }
    case 'contribute_to_goal': {
      const amount = Number(input.amount);
      if (!amount || amount <= 0) throw new Error('Укажи сумму больше 0.');
      const goal = await getActiveGoal(ctx.familyId);
      if (!goal) throw new Error('Нет активной цели. Сначала создай цель.');
      return `💰 Добавить ${formatTenge(amount)} к цели *${goal.name}*? (будет ${formatTenge(goal.current_amount + amount)} из ${formatTenge(goal.target_amount)})`;
    }
    case 'archive_goal': {
      const goal = await getActiveGoal(ctx.familyId);
      if (!goal) throw new Error('Нет активной цели.');
      return `🗂 Закрыть цель *${goal.name}*? Текущий прогресс: ${formatTenge(goal.current_amount)} из ${formatTenge(goal.target_amount)}.`;
    }
    case 'delete_transaction': {
      const ref = String(input.transaction_id ?? '');
      if (!ref) throw new Error('Не указана транзакция.');
      // Resolve the ref NOW so the confirm dialog shows the actual transaction
      // and we catch "not found" errors before the user taps ✅.
      const tx = await resolveTransactionRef(ref, ctx.familyId);
      // Replace the input so execute uses the resolved UUID, not the ambiguous ref
      (input as Record<string, unknown>).transaction_id = tx.id;
      const catName = tx.category_id
        ? (await getCategoriesForFamily(ctx.familyId)).find(c => c.id === tx.category_id)
        : null;
      return `🗑 Удалить транзакцию от ${tx.transaction_date} — ${formatTenge(tx.amount)}${tx.comment ? ` (${tx.comment})` : ''}${catName ? ` [${catName.emoji} ${catName.name}]` : ''}?`;
    }
    case 'update_transaction_category': {
      const ref = String(input.transaction_id ?? '');
      const newSlug = String(input.new_category_slug ?? '');
      if (!ref) throw new Error('Не указана транзакция.');
      if (!newSlug) throw new Error('Не указана новая категория.');
      const cat = await getCategoryBySlugInFamily(newSlug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${newSlug}' не найдена.`);
      const tx = await resolveTransactionRef(ref, ctx.familyId);
      (input as Record<string, unknown>).transaction_id = tx.id;
      return `🏷 Переклассифицировать транзакцию от ${tx.transaction_date} — ${formatTenge(tx.amount)}${tx.comment ? ` (${tx.comment})` : ''} → ${cat.emoji} *${cat.name}*?\n(Запомню ключевое слово для этой семьи — похожие траты будут автоматически попадать сюда.)`;
    }
    case 'set_monthly_plan': {
      const slug = String(input.category_slug ?? '');
      const amount = Number(input.amount);
      if (!slug) throw new Error('Укажи категорию.');
      if (amount < 0) throw new Error('Сумма не может быть отрицательной.');
      const cat = await getCategoryBySlugInFamily(slug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${slug}' не найдена.`);
      const { year, month } = currentMonthAlmaty();
      const y = (input.year as number) ?? year;
      const m = (input.month as number) ?? month;
      return `📊 Поставить лимит ${formatTenge(amount)} на ${cat.emoji} ${cat.name} за ${monthNameRu(m)} ${y}?`;
    }
    case 'create_category': {
      const name = String(input.name ?? '').trim();
      const emoji = String(input.emoji ?? '').trim();
      if (!name) throw new Error('Укажи название категории.');
      if (!emoji) throw new Error('Укажи эмодзи.');
      return `🆕 Создать категорию *${emoji} ${name}*?`;
    }
    case 'create_categories_bulk': {
      const cats = (input.categories as Array<{ name?: string; emoji?: string }> | undefined) ?? [];
      if (cats.length === 0) throw new Error('Пустой список категорий.');
      // Validate every entry before proposing
      const clean = cats.map(c => ({
        name: String(c.name ?? '').trim(),
        emoji: String(c.emoji ?? '').trim(),
      }));
      for (const c of clean) {
        if (!c.name) throw new Error('У одной из категорий пустое название.');
        if (!c.emoji) throw new Error(`У категории '${c.name}' нет эмодзи.`);
      }
      // Mutate input so execute path uses cleaned data
      (input as Record<string, unknown>).categories = clean;
      const list = clean.map(c => `${c.emoji} ${c.name}`).join(', ');
      return `🆕 Создать ${clean.length} ${clean.length === 1 ? 'категорию' : 'категорий'}: ${list}?`;
    }
    case 'rename_category': {
      const slug = String(input.slug ?? '');
      const newName = String(input.new_name ?? '').trim();
      if (!slug || !newName) throw new Error('Укажи категорию и новое название.');
      const cat = await getCategoryBySlugInFamily(slug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${slug}' не найдена.`);
      const newEmoji = input.new_emoji ? String(input.new_emoji) : cat.emoji;
      return `✏️ Переименовать ${cat.emoji} ${cat.name} → ${newEmoji} *${newName}*?`;
    }
    case 'delete_category': {
      const slug = String(input.slug ?? '');
      const reassignTo = String(input.reassign_to_slug ?? 'misc');
      const cat = await getCategoryBySlugInFamily(slug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${slug}' не найдена.`);
      const target = await getCategoryBySlugInFamily(reassignTo, ctx.familyId);
      if (!target) throw new Error(`Целевая категория '${reassignTo}' не найдена.`);
      return `🗑 Удалить ${cat.emoji} ${cat.name}? Транзакции перенесутся в ${target.emoji} ${target.name}.`;
    }
    case 'merge_categories': {
      const fromSlug = String(input.from_slug ?? '');
      const intoSlug = String(input.into_slug ?? '');
      const source = await getCategoryBySlugInFamily(fromSlug, ctx.familyId);
      const target = await getCategoryBySlugInFamily(intoSlug, ctx.familyId);
      if (!source) throw new Error(`Категория '${fromSlug}' не найдена.`);
      if (!target) throw new Error(`Категория '${intoSlug}' не найдена.`);
      return `🔀 Объединить ${source.emoji} ${source.name} в ${target.emoji} ${target.name}?`;
    }
  }
}

/**
 * Execute a previously-confirmed action. Called from handleCallback after
 * user taps ✅ Да.
 */
async function executeConfirmedAction(
  pending: PendingConfirm,
  ctx: FamilyCtx,
): Promise<string> {
  const a = pending.args as Record<string, unknown>;
  switch (pending.type) {
    case 'create_goal': {
      const goal = await createGoal({
        family_id: ctx.familyId,
        name: String(a.name),
        target_amount: Number(a.target_amount),
        deadline: String(a.deadline),
      });
      return `🎯 Цель создана: *${goal.name}* — ${formatTenge(goal.target_amount)} к ${goal.deadline}.\nВноси через "отложил N" или просто посылай траты.`;
    }
    case 'contribute_to_goal': {
      const updated = await addGoalContribution(ctx.familyId, Number(a.amount), ctx.userId);
      const pct = updated.target_amount > 0
        ? Math.min(100, Math.round((updated.current_amount / updated.target_amount) * 100))
        : 0;
      return `💰 Добавлено ${formatTenge(Number(a.amount))} к цели *${updated.name}*.\nПрогресс: ${formatTenge(updated.current_amount)} из ${formatTenge(updated.target_amount)} (${pct}%).`;
    }
    case 'archive_goal': {
      const goal = await getActiveGoal(ctx.familyId);
      if (!goal) return '🤔 Нет активной цели.';
      await archiveGoal(goal.id, ctx.familyId);
      return `🗂 Цель *${goal.name}* закрыта.`;
    }
    case 'delete_transaction': {
      await softDeleteTransaction(String(a.transaction_id), ctx.familyId);
      return '🗑 Транзакция удалена.';
    }
    case 'update_transaction_category': {
      const txnId = String(a.transaction_id);
      const newSlug = String(a.new_category_slug);
      const cat = await getCategoryBySlugInFamily(newSlug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${newSlug}' не найдена.`);

      // 1. Update the transaction
      const updated = await updateTransactionCategory(txnId, cat.id, ctx.familyId);

      // 2. Learning loop: save an override for this keyword so future similar
      //    transactions auto-route to the same category. Quietly skip if the
      //    transaction has no comment to learn from.
      if (updated.comment && updated.comment.trim().length > 0) {
        try {
          await upsertCategoryOverride(ctx.familyId, updated.comment, newSlug, ctx.userId);
        } catch (e) {
          // Non-fatal — the user's correction still stood. Just log.
          console.warn('[update_transaction_category] override save failed:', e);
        }
      }

      return `🏷 Перекатегоризовано → ${cat.emoji} *${cat.name}*. Запомнил.`;
    }
    case 'set_monthly_plan': {
      const slug = String(a.category_slug);
      const cat = await getCategoryBySlugInFamily(slug, ctx.familyId);
      if (!cat) throw new Error(`Категория '${slug}' не найдена.`);
      const { year: curY, month: curM } = currentMonthAlmaty();
      const y = (a.year as number) ?? curY;
      const m = (a.month as number) ?? curM;
      await upsertMonthlyPlan({
        family_id: ctx.familyId,
        year: y,
        month: m,
        category_id: cat.id,
        plan_type: 'expense',
        amount: Number(a.amount),
        created_by: ctx.userId,
      });
      return `📊 Лимит ${formatTenge(Number(a.amount))} на ${cat.emoji} ${cat.name} установлен.`;
    }
    case 'create_category': {
      const cat = await createCategory({
        family_id: ctx.familyId,
        name: String(a.name),
        emoji: String(a.emoji),
      });
      return `🆕 Категория создана: ${cat.emoji} *${cat.name}*.`;
    }
    case 'create_categories_bulk': {
      const cats = a.categories as Array<{ name: string; emoji: string }>;
      const { created, skipped } = await createCategoriesBulk({
        family_id: ctx.familyId,
        categories: cats,
      });
      let reply = `🆕 Создано ${created.length} ${created.length === 1 ? 'категория' : 'категорий'}:\n`;
      for (const c of created) reply += `- ${c.emoji} ${c.name}\n`;
      if (skipped.length > 0) {
        reply += `\n⚠️ Пропущено ${skipped.length}:\n`;
        for (const s of skipped) reply += `- ${s.slug} (${s.reason})\n`;
      }
      if (created.length > 0) {
        reply += `\nТеперь можешь логировать траты: напиши например "кофе 500" или "такси 2500".`;
      }
      return reply.trim();
    }
    case 'rename_category': {
      const cat = await renameCategory({
        family_id: ctx.familyId,
        slug: String(a.slug),
        new_name: String(a.new_name),
        new_emoji: a.new_emoji ? String(a.new_emoji) : undefined,
      });
      return `✏️ Переименовано: ${cat.emoji} *${cat.name}*.`;
    }
    case 'delete_category': {
      await deleteCategory({
        family_id: ctx.familyId,
        slug: String(a.slug),
        reassign_to_slug: a.reassign_to_slug ? String(a.reassign_to_slug) : undefined,
      });
      return `🗑 Категория удалена, транзакции перенесены.`;
    }
    case 'merge_categories': {
      await mergeCategories({
        family_id: ctx.familyId,
        from_slug: String(a.from_slug),
        into_slug: String(a.into_slug),
      });
      return `🔀 Категории объединены.`;
    }
  }
}

/**
 * Format a list of transactions as a Telegram-safe text block.
 * Caps at 30 rows (caller should pre-trim if needed).
 */
function formatTransactionList(
  transactions: import('@/types').Transaction[],
  categories: import('@/types').Category[],
  opts: { total: number; offset: number; hasMore: boolean },
): string {
  if (transactions.length === 0) return '📭 Нет транзакций.';

  const catMap = new Map(categories.map(c => [c.id, c]));

  const from = opts.offset + 1;
  const to = opts.offset + transactions.length;
  let text: string;
  if (opts.total <= transactions.length && opts.offset === 0) {
    text = `📋 ${transactions.length} записей:\n\n`;
  } else {
    text = `📋 Показано ${from}–${to} из ${opts.total}:\n\n`;
  }

  for (const t of transactions) {
    const cat = t.category_id ? catMap.get(t.category_id) : null;
    const icon = t.type === 'income' ? '📥' : (cat?.emoji ?? '❓');
    text += `${t.transaction_date} | ${icon} ${formatTenge(t.amount)}`;
    if (t.comment) text += ` — ${t.comment}`;
    text += '\n';
  }

  if (opts.hasMore) {
    text += `\n💡 Скажи "ещё" для следующих ${Math.min(30, opts.total - to)}, или укажи период.`;
  }

  return text.trim();
}

async function executeReadTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FamilyCtx,
): Promise<string> {
  switch (toolName) {
    case 'get_month_summary': {
      const year = input.year as number;
      const mo = input.month as number;
      const summary = await getMonthSummary(year, mo, ctx.familyId);
      return buildSummaryText(summary);
    }

    case 'search_transactions_by_comment': {
      const keyword = input.keyword as string;
      if (!keyword || typeof keyword !== 'string') return '🤔 Укажи, что искать.';
      const periodStart = input.period_start as string | undefined;
      const periodEnd = input.period_end as string | undefined;

      const result = await searchTransactionsByComment(ctx.familyId, keyword, periodStart, periodEnd);
      return formatSearchReply(
        result,
        { keyword, periodStart, periodEnd },
        await getCategoriesForFamily(ctx.familyId),
      );
    }

    case 'list_recent_transactions': {
      const limit = Math.min(Math.max(1, (input.limit as number) || 10), 30);
      const offset = Math.max(0, (input.offset as number) || 0);
      const periodStart = input.period_start as string | undefined;
      const periodEnd = input.period_end as string | undefined;

      const result = await listRecentTransactionsPaged(
        ctx.familyId, limit, offset, periodStart, periodEnd,
      );

      // Store context so user saying "ещё" later works even if conversation
      // history gets trimmed. Claude can also call us with explicit offset —
      // both paths work.
      if (result.has_more) {
        await setPendingListContext(ctx.familyId, {
          limit,
          offset: offset + result.transactions.length,
          period_start: periodStart,
          period_end: periodEnd,
        }).catch(() => {});
      } else {
        await clearPendingListContext(ctx.familyId).catch(() => {});
      }

      return formatTransactionList(
        result.transactions,
        await getCategoriesForFamily(ctx.familyId),
        { total: result.total_count, offset, hasMore: result.has_more },
      );
    }

    case 'get_top_items_by_comment': {
      const limit = Math.min(Math.max(1, (input.limit as number) || 10), 50);
      const periodStart = input.period_start as string | undefined;
      const periodEnd = input.period_end as string | undefined;
      const categoryName = input.category as string | undefined;

      let categoryId: number | undefined;
      let resolvedCategory: Category | null = null;
      if (categoryName && categoryName.trim()) {
        resolvedCategory = await resolveCategoryByName(ctx.familyId, categoryName);
        if (!resolvedCategory) {
          const cats = await getCategoriesForFamily(ctx.familyId);
          const names = cats.map((c) => `${c.emoji} ${c.name}`).join(', ');
          return `🤔 Не нашёл категорию "${categoryName}". Доступные: ${names}`;
        }
        categoryId = resolvedCategory.id;
      }

      const rows = await topItemsByComment(ctx.familyId, limit, periodStart, periodEnd, categoryId);
      if (rows.length === 0) {
        const periodHint = periodStart || periodEnd ? ' за указанный период' : '';
        const catHint = resolvedCategory ? ` в категории ${resolvedCategory.emoji} ${resolvedCategory.name}` : '';
        return `📊 Нет трат${catHint}${periodHint}.`;
      }

      let text = resolvedCategory
        ? `📊 ${resolvedCategory.emoji} ${resolvedCategory.name} — ${rows.length} позиц${rows.length === 1 ? 'ия' : rows.length < 5 ? 'ии' : 'ий'}`
        : `📊 Топ-${rows.length} товаров по тратам`;
      if (periodStart || periodEnd) {
        text += ` (${periodStart ?? '...'} → ${periodEnd ?? '...'})`;
      }
      text += ':\n\n';
      const grandTotal = rows.reduce((s, r) => s + r.total, 0);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const share = grandTotal > 0 ? Math.round((r.total / grandTotal) * 100) : 0;
        text += `${i + 1}. *${formatTenge(r.total)}* · ${r.label}`;
        if (r.count > 1) text += ` (×${r.count})`;
        text += ` — ${share}%\n`;
      }
      return text.trim();
    }

    case 'get_debts': {
      const debts = await getActiveDebts(ctx.familyId);
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
): Promise<BotResponse> {
  // Resolve family context ONCE per request — never fetched inside handlers.
  // If this returns null, the user is not whitelisted anywhere and cannot act.
  const user = await getUserByTelegramId(telegramId);
  if (!user) return textOnly('⛔ Пользователь не найден в системе.');

  const ctx: FamilyCtx = {
    familyId: user.family_id,
    userId: user.id,
    userName,
    chatId,
  };

  const text = userMessage.trim();

  // Short-circuit: ambiguous inputs ("?", "??", "!", ".", "hmm") have no
  // actionable content. Sonnet confronted with these tends to hallucinate from
  // recent conversation history (observed in prod: "?" produced a fabricated
  // reply about the PREVIOUS expense, claiming the user had just logged it).
  // Ask for clarification instead of letting the model guess.
  if (!isMeaningfulInput(text)) {
    return textOnly('🤔 Не понял вопрос. Например: "сколько на кофе?", "из чего состоит Разное?", "покажи последние 10 трат".');
  }

  const saveUserMsg = () => saveMessage(ctx.chatId, ctx.familyId, 'user', `[${userName}]: ${text}`).catch(() => {});
  const saveAssistantMsg = (reply: string) => saveMessage(ctx.chatId, ctx.familyId, 'assistant', reply).catch(() => {});

  // NOTE: /newfamily and /invite are handled in bot/handlers.ts BEFORE the
  // command-prefix strip, because chat() only receives cleanText (prefix
  // already removed). Keeping them there means this file never sees raw
  // slash-commands and can focus on natural-language / parsed intents.

  // ── 0. First-run: family has no categories yet ──
  // Families are created without default categories — user picks their own.
  // Until at least one exists, expense parsing fails with "категория не найдена",
  // so we intercept here and route EVERYTHING through Claude with category-
  // creation as the primary action. Once ≥1 category exists this branch falls
  // through and normal deterministic paths take over.
  const familyCategoriesCheck = await getCategoriesForFamily(ctx.familyId).catch(() => []);
  const isFirstRun = familyCategoriesCheck.length === 0;

  // ── 1. Undo (deterministic) ──
  if (isUndoRequest(text)) {
    const reply = await handleUndo(ctx);
    await saveUserMsg();
    await saveAssistantMsg(reply);
    return textOnly(reply);
  }

  // ── 2. Debt (deterministic) ──
  const debt = tryParseDebt(text);
  if (debt) {
    const reply = await handleDebt(debt, ctx);
    await saveUserMsg();
    await saveAssistantMsg(reply);
    return textOnly(reply);
  }

  // ── 3. Income (deterministic) ──
  const income = tryParseIncome(text);
  if (income) {
    const reply = await handleIncome(income, ctx);
    await saveUserMsg();
    await saveAssistantMsg(reply);
    return textOnly(reply);
  }

  // ── 4. Expenses (deterministic) ──
  const expenses = tryParseExpenses(text);
  if (expenses) {
    // First-run guard: can't log an expense without any categories. Guide
    // the user to set them up first instead of erroring on every line.
    if (isFirstRun) {
      const reply = firstRunWelcomeExpenseAttempt(expenses);
      await saveUserMsg();
      await saveAssistantMsg(reply);
      return textOnly(reply);
    }
    const reply = await handleExpenses(expenses, ctx);
    await saveUserMsg();
    await saveAssistantMsg(reply);
    return textOnly(reply);
  }

  // ── 5. Everything else → Sonnet (read + write tools) ──
  //
  // Philosophy: Sonnet 4.6 understands Russian phrasings + morphology much
  // better than any regex we can write. "сколько потратили на агушу",
  // "дай расходы на агушу", "hi how much did we spend on chips" — Sonnet
  // extracts the keyword + intent and picks the right tool. We lost a
  // whole evening trying to beat Sonnet with regex parsing; we won't do
  // that again. The search tool itself handles Russian morphology via
  // server-side stemming (see searchTransactionsByComment in queries.ts).
  let history: { role: string; content: string }[] = [];
  try { history = await getRecentMessages(chatId, ctx.familyId, 10); } catch { /* */ }

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
  await saveUserMsg();

  let finalReply = '';
  // Last read-tool's raw output. System prompt declares read-tool results are
  // ready-for-user text, so if Sonnet ends silent after a tool call (observed
  // in prod: "из чего состоит Разное?" triggered tool → second turn returned
  // no text), we fall back to sending the tool output directly instead of
  // saying "Не понял".
  let lastReadResult: string | null = null;
  // If a write tool is proposed, we exit the loop early with a keyboard reply
  // so the user can tap Да/Отмена. Claude's own natural-language response for
  // that turn is discarded in favor of our structured confirm message.
  let confirmResponse: BotResponse | null = null;
  const loopStart = Date.now();

  for (let i = 0; i < 5; i++) {
    // Vercel webhook has a 60s budget. If we've already burned 45s, bail so
    // the user sees something instead of Telegram timing out on its retry.
    if (Date.now() - loopStart > 45_000) {
      console.warn(`[chat] loop budget exceeded at iter ${i}, bailing`);
      finalReply = finalReply || '⌛ Это заняло слишком долго. Попробуй переформулировать или задать проще.';
      break;
    }

    console.error(`[chat] iter ${i}: sending ${messages.length} messages to ${MODEL}`);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(isFirstRun),
      tools: [...READ_TOOLS, ...WRITE_TOOLS],
      messages,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');
    const turnText = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n').trim();
    console.error(`[chat] iter ${i}: stop=${response.stop_reason} tools=${toolUses.length} text=${turnText.length}b`);
    if (turnText) finalReply = turnText;

    if (toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: ToolResult[] = [];
    for (const block of toolUses) {
      if (block.type !== 'tool_use') continue;
      const toolName = block.name;
      const input = block.input as Record<string, unknown>;

      // WRITE tool → propose + confirm
      if (WRITE_TOOL_NAMES.has(toolName)) {
        try {
          const proposal = await proposeWriteTool(toolName, input, ctx);
          // Short-circuit: return the confirm message directly to the user.
          confirmResponse = proposal;
        } catch (e) {
          // Don't kill the whole reply — tell Sonnet what went wrong and let
          // it either retry with different args or explain to the user.
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn(`[chat] write tool ${toolName} threw:`, errMsg);
          toolResults.push({
            tool_use_id: block.id,
            content: `ERROR: ${errMsg}. Fix the args and try again, or explain the issue to the user.`,
          });
          continue;
        }
        break;
      }

      // READ tool → execute + feed result back to Claude. Wrap in try/catch
      // so a single bad tool call never silences the whole reply.
      try {
        const tStart = Date.now();
        const result = await executeReadTool(toolName, input, ctx);
        console.error(`[chat] tool ${toolName} took ${Date.now() - tStart}ms, ${result.length}b`);
        toolResults.push({ tool_use_id: block.id, content: result });
        lastReadResult = result;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[chat] read tool ${toolName} threw:`, errMsg);
        toolResults.push({
          tool_use_id: block.id,
          content: `ERROR: ${errMsg}. Tell the user what went wrong and what they can try instead.`,
        });
      }
    }

    if (confirmResponse) break;

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

  if (confirmResponse) {
    await saveAssistantMsg(confirmResponse.text);
    return confirmResponse;
  }

  // If Sonnet produced no text but DID execute a read tool, ship the tool's
  // output directly. Read-tool outputs are designed to be user-ready, so this
  // is strictly better than "Не понял" when the user asked for information
  // and we successfully retrieved it but the model went silent on turn 2.
  if (!finalReply && lastReadResult) {
    console.error(`[chat] Sonnet silent after tool call; passing through read result (${lastReadResult.length}b)`);
    finalReply = lastReadResult;
  }

  // Absolute last-resort fallback — Sonnet returned no text AND no tool uses.
  if (!finalReply) {
    console.error('[chat] empty finalReply after loop — falling back to "не понял"');
    finalReply = '🤔 Не понял. Попробуй переформулировать — например: "сколько на X?" или "покажи последние 10 трат".';
  }
  await saveAssistantMsg(finalReply);
  return textOnly(finalReply);
}

// ═══════════════════════════════════════════════════════════════
// Callback-query entry point — invoked by bot handlers.ts when
// user taps ✅ Да or ❌ Отмена on a confirm prompt.
// ═══════════════════════════════════════════════════════════════

/**
 * Handle an inline-keyboard callback. `data` is the `callback_data` field
 * of the tapped button: `confirm:<nonce>` or `cancel:<nonce>`.
 *
 * Validates the nonce matches the stored pending_confirm for this family,
 * executes (or cancels) the proposed action, and returns a result BotResponse.
 */
export async function handleCallback(
  data: string,
  telegramId: number,
  userName: string,
  chatId: number,
): Promise<BotResponse> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return textOnly('⛔ Пользователь не найден.');

  const ctx: FamilyCtx = {
    familyId: user.family_id,
    userId: user.id,
    userName,
    chatId,
  };

  const [action, nonce] = data.split(':');
  if (!nonce || (action !== 'confirm' && action !== 'cancel')) {
    return textOnly('🤔 Не понял, что подтвердить.');
  }

  const pending = await getPendingConfirm(ctx.familyId);
  if (!pending) {
    return textOnly('⌛ Запрос устарел. Попробуй ещё раз.');
  }
  if (pending.nonce !== nonce) {
    return textOnly('🤔 Этот запрос уже обработан.');
  }

  // Clear regardless of action — stop the confirm window from lingering
  await clearPendingConfirm(ctx.familyId);

  if (action === 'cancel') {
    return textOnly('❌ Отменено.');
  }

  // Execute the proposed action
  try {
    return textOnly(await executeConfirmedAction(pending, ctx));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'ошибка';
    return textOnly(`❌ ${msg}`);
  }
}
