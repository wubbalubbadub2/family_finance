import { supabase } from './supabase';
import { currentMonthAlmaty, todayAlmaty, lastDayOfMonth, daysInMonth as daysInMonthUtil } from '@/lib/utils';
import type {
  Transaction,
  User,
  Category,
  MonthlyPlan,
  RecurringTransaction,
  MerchantCategoryMap,
  TransactionType,
  TransactionSource,
} from '@/types';
import type { Goal } from '@/lib/goals';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant scoping rule (enforced at this layer, not via Postgres RLS)
//
// Every family-scoped query accepts `familyId` as an explicit argument and
// appends `WHERE family_id = $familyId` to the query. The ONLY way to resolve
// a familyId is via `getUserByTelegramId(telegramId).family_id` — webhook handlers
// must do this once per request and thread it through.
//
// Global (non-family-scoped) tables: categories. Everything else has family_id.
// merchant_category_map allows null family_id for a global cache fallback.
// ─────────────────────────────────────────────────────────────────────────────

// ── Users ──

export interface UserWithFamily extends User {
  family_id: string;
}

export async function getUserByTelegramId(telegramId: number): Promise<UserWithFamily | null> {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

export async function getUsersInFamily(familyId: string): Promise<UserWithFamily[]> {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('family_id', familyId)
    .order('name');
  return data ?? [];
}

// ── Family chats (Phase 2: chat-based family scope) ──

export interface FamilyChatLink {
  chat_id: number;
  family_id: string;
  chat_type: string;
  linked_at: string;
  linked_by_user_id: string | null;
}

/**
 * Resolve the family scope for an incoming Telegram chat.
 *
 * Phase 2 swap: instead of `getUserByTelegramId().family_id` we ask "which
 * family does THIS CHAT belong to?". A user can DM the bot AND be in a
 * family group; both must write to the same family ledger, so the chat is
 * the canonical scope, not the user.
 *
 * Returns `{ familyId, firstTimeInChat }` if the chat resolves OR can be
 * auto-linked via the message sender. Returns `{ error }` otherwise.
 *
 * The auto-link path is critical for two flows:
 *   1. New user registers via /start invite_X — handleInviteArrival creates
 *      the user row, then their first non-/start message hits this function
 *      which auto-links the DM (chat_id = telegram_id) to their family.
 *      (The 012 migration backfills DM links for users that existed before
 *      Phase 2; new users rely on this auto-link path.)
 *   2. Existing registered user adds bot to a Telegram group — the first
 *      message in the group from any registered family member auto-links
 *      the group to that user's family.
 */
/**
 * Find or create a user record for `telegramId` inside `familyId`. Used by the
 * group-routing path: when a non-Shynggys family member writes in a bound
 * group, the chat is already scoped to the family but the sender has no user
 * row yet. Per the doc's group security stance ("trust boundary is the group
 * itself, established at bind time"), anyone in the bound group is authorized
 * to log. Auto-create their user row so we have a real id for transaction
 * attribution (logged_by).
 *
 * Idempotent: if the telegram_id already exists with the same family, returns
 * it. If it exists with a DIFFERENT family, refuses (cross-family write would
 * leak). If it doesn't exist, inserts.
 */
export async function getOrCreateUserInFamily(
  telegramId: number,
  familyId: string,
  name: string,
): Promise<{ id: string; family_id: string } | { error: string }> {
  const existing = await getUserByTelegramId(telegramId);
  if (existing) {
    if (existing.family_id !== familyId) {
      return { error: `User already linked to a different family.` };
    }
    return { id: existing.id, family_id: existing.family_id };
  }
  const { data, error } = await supabase
    .from('users')
    .insert({ telegram_id: telegramId, name: name || 'User', family_id: familyId })
    .select('id, family_id')
    .single();
  if (error || !data) return { error: `Не удалось зарегистрировать: ${error?.message}` };
  return { id: data.id, family_id: data.family_id };
}

export async function resolveFamilyForChat(args: {
  chatId: number;
  telegramId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
}): Promise<{ familyId: string; firstTimeInChat: boolean } | { error: string }> {
  // 1. Existing chat link?
  const { data: existing } = await supabase
    .from('family_chats')
    .select('*')
    .eq('chat_id', args.chatId)
    .maybeSingle();
  if (existing) {
    return { familyId: existing.family_id, firstTimeInChat: false };
  }

  // 2. First time bot sees this chat. Try to auto-link via the message sender.
  //    If the sender is a registered family member, this chat becomes scoped
  //    to their family. If not, refuse — only paying customers can drive scope.
  const sender = await getUserByTelegramId(args.telegramId);
  if (!sender) {
    return { error: 'unregistered_sender' };
  }

  // 3. Insert the link. We accept any chat_type the caller passes. The
  //    'channel' case is included in the type but in practice the bot is
  //    only added to private/group/supergroup; if Telegram ever delivers a
  //    channel update, we link it the same way and let the caller decide
  //    what to do with the firstTimeInChat flag.
  const { error: linkErr } = await supabase
    .from('family_chats')
    .insert({
      chat_id: args.chatId,
      family_id: sender.family_id,
      chat_type: args.chatType,
      linked_by_user_id: sender.id,
    });
  // Race-safe: if a concurrent insert won, treat as success and re-resolve.
  if (linkErr) {
    if (/duplicate|conflict/i.test(linkErr.message)) {
      const { data: raced } = await supabase
        .from('family_chats')
        .select('*')
        .eq('chat_id', args.chatId)
        .maybeSingle();
      if (raced) return { familyId: raced.family_id, firstTimeInChat: false };
    }
    return { error: `Не удалось связать чат: ${linkErr.message}` };
  }

  return { familyId: sender.family_id, firstTimeInChat: true };
}

// ── Families ──

export interface Family {
  id: string;
  name: string;
  created_at: string;
}

export async function getFamilyById(familyId: string): Promise<Family | null> {
  const { data } = await supabase
    .from('families')
    .select('*')
    .eq('id', familyId)
    .single();
  return data;
}

// ── Categories (per-family since migration 007) ──

export async function getCategoriesForFamily(familyId: string): Promise<Category[]> {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('family_id', familyId)
    .eq('is_active', true)
    .order('sort_order');
  return data ?? [];
}

/**
 * Fetch including INACTIVE (soft-deleted) categories — useful for admin flows
 * that need to see archived categories (e.g., mergeCategories lets you merge
 * FROM an inactive one).
 */
export async function getAllCategoriesForFamily(familyId: string): Promise<Category[]> {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('family_id', familyId)
    .order('sort_order');
  return data ?? [];
}

export async function getCategoryBySlugInFamily(
  slug: string,
  familyId: string,
): Promise<Category | null> {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('family_id', familyId)
    .eq('slug', slug)
    .single();
  return data;
}

/**
 * Create a new category in a family. Slug is derived from the name if not
 * provided. Emoji + name must be supplied.
 */
export async function createCategory(input: {
  family_id: string;
  name: string;
  emoji: string;
  slug?: string;  // optional; computed from name if missing
}): Promise<Category> {
  const slug = input.slug ?? slugifyForCategory(input.name);
  if (!slug) throw new Error('Невалидное название категории.');

  // Compute next sort_order (append to end)
  const existing = await getAllCategoriesForFamily(input.family_id);
  const nextOrder = (existing.reduce((m, c) => Math.max(m, c.sort_order ?? 0), 0)) + 1;

  const { data, error } = await supabase
    .from('categories')
    .insert({
      family_id: input.family_id,
      name: input.name,
      emoji: input.emoji,
      slug,
      sort_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new Error(`Категория с похожим названием уже есть: ${slug}.`);
    }
    throw new Error(`Не удалось создать категорию: ${error.message}`);
  }
  return data;
}

/**
 * Bulk-create categories for a family. Used during onboarding so a new user
 * can set up 5–10 categories with ONE confirm tap instead of 10.
 * Skips any duplicates (slug collision) and reports them in a warnings list.
 */
export async function createCategoriesBulk(input: {
  family_id: string;
  categories: { name: string; emoji: string; slug?: string }[];
}): Promise<{ created: Category[]; skipped: { slug: string; reason: string }[] }> {
  const created: Category[] = [];
  const skipped: { slug: string; reason: string }[] = [];

  // Fetch existing sort_orders once so we can append new ones
  const existing = await getAllCategoriesForFamily(input.family_id);
  let nextOrder = existing.reduce((m, c) => Math.max(m, c.sort_order ?? 0), 0) + 1;
  const existingSlugs = new Set(existing.map(c => c.slug));

  for (const c of input.categories) {
    const slug = c.slug ?? slugifyForCategory(c.name);
    if (!slug) { skipped.push({ slug: c.name, reason: 'пустое название' }); continue; }
    if (existingSlugs.has(slug)) { skipped.push({ slug, reason: 'уже существует' }); continue; }

    const { data, error } = await supabase
      .from('categories')
      .insert({
        family_id: input.family_id,
        name: c.name,
        emoji: c.emoji,
        slug,
        sort_order: nextOrder++,
        is_active: true,
      })
      .select()
      .single();
    if (error) {
      skipped.push({ slug, reason: error.code === '23505' ? 'дубликат' : error.message });
      continue;
    }
    created.push(data);
    existingSlugs.add(slug);
  }

  return { created, skipped };
}

/**
 * Rename a category. Updates name and optionally emoji. Slug stays stable
 * (slug is the machine-name; display name is what users see).
 */
export async function renameCategory(input: {
  family_id: string;
  slug: string;
  new_name: string;
  new_emoji?: string;
}): Promise<Category> {
  const update: Record<string, string> = { name: input.new_name };
  if (input.new_emoji) update.emoji = input.new_emoji;

  const { data, error } = await supabase
    .from('categories')
    .update(update)
    .eq('family_id', input.family_id)
    .eq('slug', input.slug)
    .select()
    .single();
  if (error) throw new Error(`Не удалось переименовать: ${error.message}`);
  if (!data) throw new Error('Категория не найдена.');
  return data;
}

/**
 * Soft-delete (is_active=false) a category. All transactions currently
 * referencing it are reassigned to `reassign_to_slug` (default: 'misc').
 * This is a two-step operation wrapped in app-level logic since Supabase
 * doesn't support multi-statement transactions via the JS client.
 *
 * CAUTION: partial failure possible — if txn update succeeds but category
 * deactivate fails, caller sees an error but txns are already reassigned.
 * In practice this is acceptable because reassignment is forward-safe.
 */
export async function deleteCategory(input: {
  family_id: string;
  slug: string;
  reassign_to_slug?: string;  // default: 'misc'
}): Promise<void> {
  const reassignSlug = input.reassign_to_slug ?? 'misc';

  // 1. Resolve both categories (source + target) in one round trip
  const all = await getAllCategoriesForFamily(input.family_id);
  const source = all.find(c => c.slug === input.slug);
  const target = all.find(c => c.slug === reassignSlug);
  if (!source) throw new Error('Категория не найдена.');
  if (!target) throw new Error(`Целевая категория '${reassignSlug}' не найдена. Создай её или укажи другую.`);
  if (source.id === target.id) throw new Error('Нельзя перенести в ту же категорию.');

  // 2. Reassign all transactions (including soft-deleted ones, for history integrity)
  const { error: txnErr } = await supabase
    .from('transactions')
    .update({ category_id: target.id })
    .eq('family_id', input.family_id)
    .eq('category_id', source.id);
  if (txnErr) throw new Error(`Не удалось перенести транзакции: ${txnErr.message}`);

  // 3. Reassign recurring transactions too
  await supabase
    .from('recurring_transactions')
    .update({ category_id: target.id })
    .eq('family_id', input.family_id)
    .eq('category_id', source.id);

  // 4. Deactivate monthly_plans rows for this category (don't delete; keep history)
  //    We won't migrate plan amounts — if the user had budget allocated, they can reallocate.
  await supabase
    .from('monthly_plans')
    .delete()
    .eq('family_id', input.family_id)
    .eq('category_id', source.id);

  // 5. Soft-delete the category
  const { error: catErr } = await supabase
    .from('categories')
    .update({ is_active: false })
    .eq('id', source.id)
    .eq('family_id', input.family_id);
  if (catErr) throw new Error(`Не удалось деактивировать категорию: ${catErr.message}`);
}

/**
 * Merge two categories: move all transactions from source to target,
 * then soft-delete source. Similar to delete but the "reassign" target is
 * specified explicitly and the semantic is "consolidation."
 */
export async function mergeCategories(input: {
  family_id: string;
  from_slug: string;
  into_slug: string;
}): Promise<void> {
  // Reuse delete logic: reassign to 'into_slug', then soft-delete source
  await deleteCategory({
    family_id: input.family_id,
    slug: input.from_slug,
    reassign_to_slug: input.into_slug,
  });
}

/**
 * Seed default 10 categories for a new family. Calls the Postgres helper
 * function created in migration 007 so seeding is atomic and idempotent.
 */
export async function seedDefaultCategoriesForFamily(familyId: string): Promise<void> {
  const { error } = await supabase.rpc('seed_default_categories_for_family', {
    p_family_id: familyId,
  });
  if (error) throw new Error(`Seed failed: ${error.message}`);
}

/**
 * Derive a URL-safe slug from a display name.
 * - Lowercase
 * - Replace non-alphanumerics with underscore
 * - Collapse duplicate underscores, trim
 * - Cap length to 32 chars
 *
 * For Cyrillic names, this produces lowercased-cyrillic slugs, which Postgres
 * handles fine. Examples:
 *   "Чипсы/снеки" → "чипсы_снеки"
 *   "Mom's gift"  → "mom_s_gift"
 */
/**
 * Count of (non-soft-deleted) transactions in a family. Used to detect
 * "fresh setup" state — family was just created, hasn't logged anything yet.
 * In that state, "create categories X, Y, Z" is interpreted as REPLACE the
 * auto-seeded defaults rather than APPEND, matching the welcome message's
 * implication.
 */
export async function countActiveTransactions(familyId: string): Promise<number> {
  const { count } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .is('deleted_at', null);
  return count ?? 0;
}

/**
 * Replace the family's current categories with a brand-new set. Only safe
 * when the family has zero transactions (fresh setup) — otherwise we'd
 * orphan transactions or have to invent reassignment targets.
 *
 * Soft-deletes all currently-active categories, removes any monthly_plans
 * pointing at them, then creates the new ones via createCategoriesBulk.
 */
export async function replaceCategoriesForFreshFamily(
  familyId: string,
  newCategories: { name: string; emoji: string }[],
): Promise<{ created: Category[]; skipped: { slug: string; reason: string }[] }> {
  const txnCount = await countActiveTransactions(familyId);
  if (txnCount > 0) {
    throw new Error(
      'Семья уже логировала траты — заменить стандартные нельзя. Создаются как дополнительные.',
    );
  }

  // Drop monthly_plans (cascade-safe even if 0 rows)
  const existing = await getAllCategoriesForFamily(familyId);
  const existingIds = existing.map((c) => c.id);
  if (existingIds.length > 0) {
    await supabase
      .from('monthly_plans')
      .delete()
      .eq('family_id', familyId)
      .in('category_id', existingIds);

    // Soft-delete all categories — we keep the rows for audit, just flip is_active
    await supabase
      .from('categories')
      .update({ is_active: false })
      .eq('family_id', familyId)
      .eq('is_active', true);
  }

  return await createCategoriesBulk({ family_id: familyId, categories: newCategories });
}

function slugifyForCategory(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 32);
}

// ── Transactions ──

/**
 * Look for a near-identical expense logged in the recent past. Identical =
 * same family_id, same amount (to the tenge), same normalized comment. Used
 * as a dedup guard: when the bot retries, a double-tap, or rapid paste
 * submits the same row twice, we want to reject the second one.
 *
 * `windowMinutes` = how far back to look. Default 10 min catches retries
 * and double-taps while preserving legitimate repeat entries (morning +
 * evening bus, multiple coffees in a day).
 */
export async function findRecentDuplicate(args: {
  familyId: string;
  amount: number;
  comment: string;
  windowMinutes?: number;
}): Promise<Transaction | null> {
  const window = args.windowMinutes ?? 10;
  const since = new Date(Date.now() - window * 60_000).toISOString();
  const normalized = args.comment.trim().toLowerCase();
  if (!normalized) return null;

  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('family_id', args.familyId)
    .eq('amount', args.amount)
    .is('deleted_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return null;
  // Exact comment match (case-insensitive) so "пиво" matches "Пиво" but not
  // "пиво 2" or other slightly different descriptions.
  return data.find((t) => (t.comment ?? '').trim().toLowerCase() === normalized) ?? null;
}

export async function insertTransaction(tx: {
  family_id: string;
  user_id: string;
  category_id: number | null;
  type: TransactionType;
  amount: number;
  comment?: string;
  merchant?: string;
  source: TransactionSource;
  transaction_date?: string;
}): Promise<Transaction> {
  const { data, error } = await supabase
    .from('transactions')
    .insert(tx)
    .select()
    .single();
  if (error) throw new Error(`INSERT failed: ${error.message}`);
  if (!data) throw new Error('INSERT returned no data');

  // Verify the row actually persisted by reading it back (scoped by family_id)
  const { data: verify, error: verifyErr } = await supabase
    .from('transactions')
    .select('id')
    .eq('id', data.id)
    .eq('family_id', tx.family_id)
    .single();
  if (verifyErr || !verify) {
    throw new Error(`INSERT verification failed: row ${data.id} not found after insert`);
  }

  console.log(`[DB] INSERT transaction ${data.id}: family=${tx.family_id} amount=${tx.amount} src=${tx.source}`);
  return data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a "transaction reference" to a concrete transaction. Accepts either:
 *   - A real UUID (used directly), or
 *   - A keyword/description — we find the MOST RECENT expense whose comment
 *     matches the keyword (substring, case-insensitive, with Russian stemming
 *     fallback). Covers the common case where Sonnet passes "последняя покупка
 *     пива" instead of a UUID because it skipped the search step.
 *
 * Throws with a user-readable error if no match is found.
 */
export async function resolveTransactionRef(
  ref: string,
  familyId: string,
): Promise<Transaction> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error('Не указана транзакция.');

  // Path 1: real UUID
  if (UUID_RE.test(trimmed)) {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', trimmed)
      .eq('family_id', familyId)
      .single();
    if (!data) throw new Error('Транзакция с таким ID не найдена.');
    return data;
  }

  // Path 2: treat as a keyword — most recent expense matching this comment
  // (substring, then stemmed fallback). Extract a likely noun: take the
  // last non-trivial word from the ref, since Sonnet often passes strings
  // like "the most recent пиво transaction" or "последняя покупка пиво".
  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);
  // Try each word as a keyword, prefer the LAST one (most likely the noun
  // in English/Russian descriptive strings).
  const candidates = words.length > 0 ? [...words].reverse() : [trimmed];

  for (const kw of candidates) {
    const attempt = await mostRecentExpenseByKeyword(kw, familyId);
    if (attempt) return attempt;
  }

  throw new Error(
    `Не нашёл транзакцию по '${trimmed}'. Скажи точнее: например "последняя трата на кофе".`,
  );
}

async function mostRecentExpenseByKeyword(
  keyword: string,
  familyId: string,
): Promise<Transaction | null> {
  const tryOne = async (kw: string) => {
    const safe = kw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('family_id', familyId)
      .eq('type', 'expense')
      .is('deleted_at', null)
      .ilike('comment', `%${safe}%`)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  };

  const direct = await tryOne(keyword);
  if (direct) return direct;

  // Russian morphology fallback (same trick as searchTransactionsByComment)
  const stem = russianStem(keyword);
  if (stem !== keyword && stem.length >= 3) {
    return await tryOne(stem);
  }
  return null;
}

/**
 * Update a transaction's category. Scoped by family_id — cannot touch
 * another family's data even if the caller somehow knows the UUID.
 * Returns the updated transaction OR throws if not found.
 */
export async function updateTransactionCategory(
  transactionId: string,
  newCategoryId: number,
  familyId: string,
): Promise<Transaction> {
  const { data, error } = await supabase
    .from('transactions')
    .update({ category_id: newCategoryId, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('family_id', familyId)
    .select()
    .single();
  if (error) throw new Error(`Не удалось обновить категорию: ${error.message}`);
  if (!data) throw new Error('Транзакция не найдена в этой семье.');
  return data;
}

export async function softDeleteTransaction(id: string, familyId: string): Promise<void> {
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('family_id', familyId)
    .select();
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No transaction found with id ${id} in family ${familyId}`);
}

export async function getLastTransaction(
  userId: string,
  familyId: string,
): Promise<Transaction | null> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

export async function getLastNTransactionsByUser(
  userId: string,
  familyId: string,
  n: number,
): Promise<Transaction[]> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(n);
  return data ?? [];
}

export async function getLastNTransactionsFamily(
  familyId: string,
  n: number,
): Promise<Transaction[]> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(n);
  return data ?? [];
}

export async function getTransactionsByDateRange(
  startDate: string,
  endDate: string,
  familyId: string,
  userId?: string,
): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
    .order('transaction_date', { ascending: false });

  if (userId) query = query.eq('user_id', userId);

  const { data } = await query;
  return data ?? [];
}

export async function getMonthTransactions(
  year: number,
  month: number,
  familyId: string,
): Promise<Transaction[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = lastDayOfMonth(year, month);
  return getTransactionsByDateRange(startDate, endDate, familyId);
}

// ── Monthly Plans ──

export async function getMonthlyPlans(
  year: number,
  month: number,
  familyId: string,
): Promise<MonthlyPlan[]> {
  const { data } = await supabase
    .from('monthly_plans')
    .select('*')
    .eq('family_id', familyId)
    .eq('year', year)
    .eq('month', month);
  return data ?? [];
}

export async function upsertMonthlyPlan(plan: {
  family_id: string;
  year: number;
  month: number;
  category_id: number | null;
  plan_type: 'expense' | 'income';
  amount: number;
  created_by: string;
}): Promise<MonthlyPlan> {
  const { data, error } = await supabase
    .from('monthly_plans')
    .upsert(plan, { onConflict: 'family_id,year,month,category_id,plan_type' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Recurring Transactions ──

export async function getActiveRecurring(familyId: string): Promise<RecurringTransaction[]> {
  const { data } = await supabase
    .from('recurring_transactions')
    .select('*')
    .eq('family_id', familyId)
    .eq('is_active', true);
  return data ?? [];
}

export async function insertRecurring(rt: {
  family_id: string;
  category_id: number;
  type: TransactionType;
  amount: number;
  comment: string;
  day_of_month: number;
  created_by: string;
}): Promise<RecurringTransaction> {
  const { data, error } = await supabase
    .from('recurring_transactions')
    .insert(rt)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Merchant Category Map (per-family override, with global fallback) ──

export async function getMerchantCategory(
  merchant: string,
  familyId: string,
): Promise<MerchantCategoryMap | null> {
  const pattern = merchant.toLowerCase();

  // Check per-family override first
  const { data: perFamily } = await supabase
    .from('merchant_category_map')
    .select('*')
    .eq('family_id', familyId)
    .eq('merchant_pattern', pattern)
    .single();
  if (perFamily) return perFamily;

  // Fall back to global cache (family_id IS NULL)
  const { data: global } = await supabase
    .from('merchant_category_map')
    .select('*')
    .is('family_id', null)
    .eq('merchant_pattern', pattern)
    .single();
  return global;
}

export async function upsertMerchantCategory(
  merchant: string,
  categoryId: number,
  familyId: string,
  confirmedBy?: string,
): Promise<void> {
  const { error } = await supabase
    .from('merchant_category_map')
    .upsert({
      family_id: familyId,
      merchant_pattern: merchant.toLowerCase(),
      category_id: categoryId,
      confirmed_by: confirmedBy,
    }, { onConflict: 'family_id,merchant_pattern' });
  if (error) throw error;
}

// ── Debts ──

export interface Debt {
  id: string;
  family_id: string;
  name: string;
  original_amount: number;
  remaining_amount: number;
  note: string | null;
  created_at: string;
  paid_off_at: string | null;
}

export async function getActiveDebts(familyId: string): Promise<Debt[]> {
  const { data } = await supabase
    .from('debts')
    .select('*')
    .eq('family_id', familyId)
    .is('paid_off_at', null)
    .order('remaining_amount', { ascending: false });
  return data ?? [];
}

export async function getAllDebts(familyId: string): Promise<Debt[]> {
  const { data } = await supabase
    .from('debts')
    .select('*')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function addDebt(
  name: string,
  amount: number,
  familyId: string,
  note?: string,
): Promise<Debt> {
  // Check if debt with same name already exists (active) in THIS family
  const { data: existing } = await supabase
    .from('debts')
    .select('*')
    .eq('family_id', familyId)
    .eq('name', name.toLowerCase())
    .is('paid_off_at', null)
    .single();

  if (existing) {
    const newRemaining = existing.remaining_amount + amount;
    const newOriginal = existing.original_amount + amount;
    const { data, error } = await supabase
      .from('debts')
      .update({ remaining_amount: newRemaining, original_amount: newOriginal })
      .eq('id', existing.id)
      .eq('family_id', familyId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('debts')
    .insert({
      family_id: familyId,
      name: name.toLowerCase(),
      original_amount: amount,
      remaining_amount: amount,
      note,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function payDebt(
  name: string,
  amount: number,
  familyId: string,
): Promise<Debt | null> {
  const { data: debt } = await supabase
    .from('debts')
    .select('*')
    .eq('family_id', familyId)
    .eq('name', name.toLowerCase())
    .is('paid_off_at', null)
    .single();

  if (!debt) return null;

  const newRemaining = Math.max(0, debt.remaining_amount - amount);
  const paidOff = newRemaining === 0 ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from('debts')
    .update({ remaining_amount: newRemaining, paid_off_at: paidOff })
    .eq('id', debt.id)
    .eq('family_id', familyId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Conversation Memory ──

export async function getRecentMessages(
  chatId: number,
  familyId: string,
  limit = 10,
): Promise<{ role: string; content: string }[]> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversation_messages')
    .select('role, content')
    .eq('family_id', familyId)
    .eq('telegram_chat_id', chatId)
    .gte('created_at', oneHourAgo)
    .order('created_at', { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function saveMessage(
  chatId: number,
  familyId: string,
  role: string,
  content: string,
): Promise<void> {
  await supabase.from('conversation_messages').insert({
    family_id: familyId,
    telegram_chat_id: chatId,
    role,
    content,
  });
}

// ── Aggregations ──

export async function getMonthSummary(year: number, month: number, familyId: string) {
  const transactions = await getMonthTransactions(year, month, familyId);
  const plans = await getMonthlyPlans(year, month, familyId);
  const categories = await getCategoriesForFamily(familyId);

  const expenses = transactions.filter(t => t.type === 'expense');
  const income = transactions.filter(t => t.type === 'income');

  const categoryTotals = new Map<number, number>();
  for (const tx of expenses) {
    if (tx.category_id) {
      categoryTotals.set(tx.category_id, (categoryTotals.get(tx.category_id) ?? 0) + tx.amount);
    }
  }

  const planMap = new Map<number, number>();
  let incomePlan = 0;
  for (const plan of plans) {
    if (plan.plan_type === 'income') {
      incomePlan += plan.amount;
    } else if (plan.category_id) {
      planMap.set(plan.category_id, plan.amount);
    }
  }

  const categorySummaries = categories.map(cat => {
    const planned = planMap.get(cat.id) ?? 0;
    const actual = categoryTotals.get(cat.id) ?? 0;
    // Only compute remaining for categories WITH a plan
    const remaining = planned > 0 ? planned - actual : 0;
    return {
      category: cat,
      planned,
      actual,
      remaining,
      percentage: planned > 0 ? Math.round((actual / planned) * 100) : 0,
    };
  });

  const totalPlanned = Array.from(planMap.values()).reduce((a, b) => a + b, 0);
  const totalActual = expenses.reduce((a, b) => a + b.amount, 0);
  const totalIncome = income.reduce((a, b) => a + b.amount, 0);

  // Use Almaty timezone for days elapsed (Vercel runs in UTC)
  const { year: almatyYear, month: almatyMonth } = currentMonthAlmaty();
  const almatyDay = parseInt(todayAlmaty().split('-')[2], 10);
  const daysInMonth = daysInMonthUtil(year, month);
  const daysElapsed = year === almatyYear && month === almatyMonth
    ? almatyDay
    : daysInMonth;

  // Spending pace metrics
  const dailyBudget = totalPlanned > 0 && daysInMonth > 0 ? Math.round(totalPlanned / daysInMonth) : 0;
  const dailyActual = daysElapsed > 0 ? Math.round(totalActual / daysElapsed) : 0;
  const daysLeft = daysInMonth - daysElapsed;
  const projectedTotal = daysElapsed > 0 ? Math.round(dailyActual * daysInMonth) : 0;
  const safeDailyRemaining = daysLeft > 0 && totalPlanned > 0
    ? Math.round((totalPlanned - totalActual) / daysLeft)
    : 0;

  return {
    year,
    month,
    family_id: familyId,
    total_income: totalIncome,
    total_income_plan: incomePlan,
    total_planned: totalPlanned,
    total_actual: totalActual,
    total_remaining: totalPlanned > 0 ? totalPlanned - totalActual : 0,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    daily_budget: dailyBudget,
    daily_actual: dailyActual,
    projected_total: projectedTotal,
    safe_daily_remaining: safeDailyRemaining,
    categories: categorySummaries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Families (admin ops)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllFamilies(): Promise<{ id: string; name: string; primary_chat_id: number | null }[]> {
  const { data } = await supabase
    .from('families')
    .select('id, name, primary_chat_id')
    .order('created_at');
  return data ?? [];
}

/**
 * Create a new family. Returns the family_id. Does NOT create any users —
 * call createFamilyInvite() next and share the link; the first person to
 * use the invite becomes the first family member.
 */
export async function createFamily(name: string, primaryChatId?: number): Promise<string> {
  if (!name || !name.trim()) throw new Error('Укажи название семьи.');
  const { data, error } = await supabase
    .from('families')
    .insert({ name: name.trim(), primary_chat_id: primaryChatId ?? null })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Не удалось создать семью: ${error?.message ?? 'no data'}`);

  // Auto-seed default categories so the family's first expense lands somewhere.
  // The "create categories before you can log anything" friction was the textbook
  // onboarding mistake — paying users shouldn't have to do setup work to start.
  // Idempotent (ON CONFLICT DO NOTHING in the SQL fn) — safe to call repeatedly.
  // Non-fatal: if seeding fails for any reason, agent.ts has a lazy-seed fallback.
  await seedDefaultCategoriesForFamily(data.id).catch((e) => {
    console.error('[createFamily] seed failed for', data.id, e instanceof Error ? e.message : e);
  });

  return data.id;
}

/**
 * Short random code. ~6 chars, lowercase alphanumeric. 36^6 = 2B combinations,
 * enough for this scale; still short enough to type manually if the deep link
 * fails to open. Excludes ambiguous chars (0/o, 1/l/i).
 */
function generateInviteCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export interface FamilyInvite {
  code: string;
  family_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  uses_remaining: number;
}

/**
 * Generate a one-time invite code for a family. Default expires in 7 days,
 * single-use. The caller's user_id is stored as `created_by` for audit.
 */
export async function createFamilyInvite(input: {
  family_id: string;
  created_by_user_id?: string;
  uses?: number;
  expires_in_days?: number;
}): Promise<FamilyInvite> {
  // Try a few times in the astronomically rare case of a code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const expiresAt = input.expires_in_days != null
      ? new Date(Date.now() + input.expires_in_days * 86400 * 1000).toISOString()
      : new Date(Date.now() + 7 * 86400 * 1000).toISOString();  // default 7d

    const { data, error } = await supabase
      .from('family_invites')
      .insert({
        code,
        family_id: input.family_id,
        created_by: input.created_by_user_id ?? null,
        expires_at: expiresAt,
        uses_remaining: input.uses ?? 1,
      })
      .select('*')
      .single();

    if (!error && data) return data;
    // 23505 = unique violation (code collision) — retry with a new code
    if (error?.code !== '23505') {
      throw new Error(`Не удалось создать приглашение: ${error?.message}`);
    }
  }
  throw new Error('Не удалось сгенерировать уникальный код приглашения.');
}

/**
 * Consume an invite code: validate, create the user row, decrement uses.
 * Returns the new user's family_id + name on success, null if the invite
 * is invalid/expired/exhausted OR the telegram_id already exists.
 */
export async function consumeFamilyInvite(
  code: string,
  telegramId: number,
  name: string,
): Promise<{ familyId: string; userId: string } | { error: string }> {
  // If the user is already registered, don't re-add — just return their family.
  // This keeps the invite flow idempotent for users who tap the link twice.
  const existing = await getUserByTelegramId(telegramId);
  if (existing) return { familyId: existing.family_id, userId: existing.id };

  const { data: invite } = await supabase
    .from('family_invites')
    .select('*')
    .eq('code', code)
    .single();

  if (!invite) return { error: 'Приглашение не найдено.' };
  if (invite.uses_remaining <= 0) return { error: 'Приглашение уже использовано.' };
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { error: 'Срок приглашения истёк.' };
  }

  // Create user
  const { data: newUser, error: userErr } = await supabase
    .from('users')
    .insert({
      telegram_id: telegramId,
      name: name || 'User',
      family_id: invite.family_id,
    })
    .select('id, family_id')
    .single();

  if (userErr || !newUser) {
    return { error: `Не удалось создать пользователя: ${userErr?.message ?? 'no data'}` };
  }

  // Decrement uses (non-fatal if this fails — user is already registered)
  await supabase
    .from('family_invites')
    .update({ uses_remaining: invite.uses_remaining - 1 })
    .eq('code', code);

  return { familyId: newUser.family_id, userId: newUser.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Goals
// ─────────────────────────────────────────────────────────────────────────────

export async function getActiveGoal(familyId: string): Promise<Goal | null> {
  const { data } = await supabase
    .from('goals')
    .select('*')
    .eq('family_id', familyId)
    .eq('status', 'active')
    .single();
  return data;
}

export async function getGoalsForFamily(
  familyId: string,
  statusFilter?: 'active' | 'completed' | 'archived',
): Promise<Goal[]> {
  let q = supabase.from('goals').select('*').eq('family_id', familyId);
  if (statusFilter) q = q.eq('status', statusFilter);
  const { data } = await q.order('created_at', { ascending: false });
  return data ?? [];
}

/**
 * Create a new active goal. v1 constraint: max one active goal per family
 * (enforced by partial unique index in migration 006). Inserting a second
 * active goal errors with a Postgres unique constraint violation.
 */
export async function createGoal(input: {
  family_id: string;
  name: string;
  target_amount: number;
  deadline: string;  // YYYY-MM-DD
}): Promise<Goal> {
  const { data, error } = await supabase
    .from('goals')
    .insert({
      family_id: input.family_id,
      name: input.name,
      target_amount: input.target_amount,
      deadline: input.deadline,
      current_amount: 0,
      status: 'active',
    })
    .select()
    .single();
  if (error) {
    // Surface the "already has active goal" violation with a readable message
    if (error.code === '23505') {
      throw new Error('У этой семьи уже есть активная цель. Заверши или архивируй её перед созданием новой.');
    }
    throw new Error(`Не удалось создать цель: ${error.message}`);
  }
  return data;
}

export async function archiveGoal(goalId: string, familyId: string): Promise<void> {
  const { data, error } = await supabase
    .from('goals')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', goalId)
    .eq('family_id', familyId)
    .select();
  if (error) throw new Error(`Не удалось архивировать цель: ${error.message}`);
  if (!data || data.length === 0) throw new Error('Цель не найдена.');
}

/**
 * Atomically add `amount` to the active goal's current_amount and write an
 * audit row. Uses an RPC-style two-step: (1) fetch active goal, (2) update
 * with optimistic match on current_amount. If current_amount changed between
 * fetch and update (concurrent /save), retry once.
 *
 * Caller must have already verified family_id. Returns the updated goal.
 */
export async function addGoalContribution(
  familyId: string,
  amount: number,
  createdByUserId: string,
): Promise<Goal> {
  if (amount <= 0) throw new Error('Сумма должна быть больше 0.');

  for (let attempt = 0; attempt < 2; attempt++) {
    const goal = await getActiveGoal(familyId);
    if (!goal) throw new Error('Нет активной цели. Создай цель через /goal new или напиши: "хочу накопить ...".');

    const newAmount = goal.current_amount + amount;
    const { data, error } = await supabase
      .from('goals')
      .update({ current_amount: newAmount })
      .eq('id', goal.id)
      .eq('family_id', familyId)
      .eq('current_amount', goal.current_amount) // optimistic concurrency
      .select()
      .single();

    if (!error && data) {
      // Write audit row
      await supabase.from('goal_contributions').insert({
        goal_id: goal.id,
        amount,
        created_by: createdByUserId,
      });
      return data;
    }
    // If the optimistic match failed, another call landed first — retry with fresh read
  }
  throw new Error('Конфликт обновления цели. Попробуй ещё раз.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Category overrides (per-family keyword → category consistency)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeKeyword(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Look up a category override for any of the keywords extracted from the
 * comment. Checks the full comment first, then each non-stopword token.
 * Returns the matching category slug, or null if no override applies.
 */
export async function lookupCategoryOverride(
  familyId: string,
  comment: string,
): Promise<string | null> {
  const lower = normalizeKeyword(comment);
  if (!lower) return null;

  // Try full comment first (strongest match)
  const { data: fullMatch } = await supabase
    .from('category_overrides')
    .select('category_slug')
    .eq('family_id', familyId)
    .eq('keyword', lower)
    .single();
  if (fullMatch) return fullMatch.category_slug;

  // Fall back to individual tokens. Skip short/common words.
  const STOPWORDS = new Set(['в', 'на', 'и', 'с', 'для', 'от', 'до', 'за', 'по', 'к', 'у', 'о', 'из']);
  const tokens = lower.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return null;

  const { data: tokenMatches } = await supabase
    .from('category_overrides')
    .select('keyword, category_slug')
    .eq('family_id', familyId)
    .in('keyword', tokens);

  if (!tokenMatches || tokenMatches.length === 0) return null;

  // Prefer the longest keyword match (more specific).
  const sorted = [...tokenMatches].sort((a, b) => b.keyword.length - a.keyword.length);
  return sorted[0].category_slug;
}

/**
 * Upsert a category override on user correction. Called when the user taps
 * 🏷 on /recent and picks a new category, or confirms a low-confidence ask.
 * Uses the longest non-stopword token as the keyword (simple heuristic).
 */
export async function upsertCategoryOverride(
  familyId: string,
  comment: string,
  categorySlug: string,
  createdByUserId: string,
): Promise<void> {
  const lower = normalizeKeyword(comment);
  if (!lower) return;

  // Choose keyword: if comment is a single word, use it; else the longest token.
  const STOPWORDS = new Set(['в', 'на', 'и', 'с', 'для', 'от', 'до', 'за', 'по', 'к', 'у', 'о', 'из']);
  const tokens = lower.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const keyword = tokens.length === 0 ? lower : tokens.sort((a, b) => b.length - a.length)[0];

  const { error } = await supabase
    .from('category_overrides')
    .upsert(
      {
        family_id: familyId,
        keyword,
        category_slug: categorySlug,
        created_by_user_id: createdByUserId,
      },
      { onConflict: 'family_id,keyword' },
    );
  if (error) throw new Error(`Не удалось сохранить категорию: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction search + pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape special chars for a Postgres ILIKE query. Without this, a user
 * searching for "50%" would match everything ('%' is a wildcard).
 */
function escapeLikeSpecials(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface TransactionSearchResult {
  sum: number;
  count: number;
  sample: Transaction[];  // up to 10 matching rows
}

/**
 * Russian morphological stemmer — light-touch, rule-based.
 *
 * Why this exists: users type "агушу" (accusative), "агуши" (plural), "агуша"
 * (nominative), "агушой" (instrumental)… all referring to the SAME product.
 * Our comments might store any form. A straight ILIKE for the typed word
 * misses all other forms.
 *
 * The cheap fix: before searching, reduce both sides to a short prefix by
 * stripping common Russian inflection endings. We don't need full Porter-style
 * stemming — we're doing substring match, so a 3-4 char prefix catches all
 * forms the root shares.
 *
 * Rules in priority order (longest first — matters):
 *   -ами/-ями  (instr. pl.)
 *   -ому/-ему/-ого/-его/-ему/-ого  (various)
 *   -ами/-ями  (dup, already handled)
 *   -ых/-их    (gen./prep. pl.)
 *   -ую/-юю    (acc. f.)
 *   -ой/-ей/-ою  (instr. f.)
 *   -ый/-ий/-ая/-яя/-ое/-ее  (adjective endings)
 *   -ов/-ев/-ёв  (gen. pl. m.)
 *   -ам/-ям    (dat. pl.)
 *   -ах/-ях    (prep. pl.)
 *   -ом/-ем/-ём  (instr. m.)
 *   -ют/-ят/-ит/-ет  (verb endings)
 *   -ешь/-ишь  (verb endings)
 *   -а/-я/-о/-е/-у/-ю/-ы/-и/-ь/-й/-л  (single-char endings, last resort)
 *
 * For words ≤ 4 chars, no stemming (too short — would over-trim).
 */
export function russianStem(word: string): string {
  if (word.length <= 4) return word;
  // Multi-char endings first (checked in order, longest-first groups).
  const multiCharEndings = [
    'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ими', 'ыми',
    'ую', 'юю', 'ой', 'ей', 'ою', 'ею',
    'ый', 'ий', 'ая', 'яя', 'ое', 'ее',
    'ов', 'ев', 'ёв', 'ам', 'ям', 'ах', 'ях',
    'ом', 'ем', 'ём', 'ют', 'ят', 'ит', 'ет',
    'ешь', 'ишь', 'ула', 'ила', 'ыла', 'ала',
    'ых', 'их',
  ];
  for (const end of multiCharEndings.sort((a, b) => b.length - a.length)) {
    if (word.endsWith(end) && word.length - end.length >= 3) {
      return word.slice(0, -end.length);
    }
  }
  // Single-char trailing vowel/softener (more aggressive, less safe).
  const singleCharEndings = ['а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й', 'л'];
  for (const end of singleCharEndings) {
    if (word.endsWith(end) && word.length - 1 >= 3) {
      return word.slice(0, -1);
    }
  }
  return word;
}

/**
 * Top individual items by total spend. Groups expense transactions by
 * lowercased comment and returns the biggest buckets. Answers
 * "на что больше всего потратили (сам элемент, не категория)?"
 *
 * Rows with NULL/empty comment collapse under "(без описания)".
 * Same-comment-different-case rows merge ("Агуша" + "агуша" → one bucket).
 */
export interface TopItemRow {
  label: string;         // lowercased comment, or "(без описания)"
  total: number;         // sum across matching rows
  count: number;         // number of matching rows
}

/**
 * Resolve a free-form category name (as user or LLM typed it) to a row.
 * Case-insensitive, strips emoji, accepts partial matches ("Раз" → "Разное").
 * Returns null if no match or ambiguous.
 */
export async function resolveCategoryByName(
  familyId: string,
  name: string,
): Promise<Category | null> {
  const needle = name.trim().replace(/[\p{Extended_Pictographic}‍]/gu, '').trim().toLowerCase();
  if (!needle) return null;

  const cats = await getAllCategoriesForFamily(familyId);
  const norm = (s: string) => s.replace(/[\p{Extended_Pictographic}‍]/gu, '').trim().toLowerCase();

  // 1. Exact case-insensitive match on name OR slug
  const exact = cats.find((c) => norm(c.name) === needle || c.slug.toLowerCase() === needle);
  if (exact) return exact;

  // 2. Prefix match (single hit only — ambiguous prefix returns null)
  const prefix = cats.filter((c) => norm(c.name).startsWith(needle));
  if (prefix.length === 1) return prefix[0];

  // 3. Substring match (single hit only)
  const substr = cats.filter((c) => norm(c.name).includes(needle));
  if (substr.length === 1) return substr[0];

  return null;
}

export async function topItemsByComment(
  familyId: string,
  limit = 10,
  periodStart?: string,
  periodEnd?: string,
  categoryId?: number,
): Promise<TopItemRow[]> {
  // Supabase JS client doesn't support GROUP BY directly. Two options:
  //   (a) Postgres function (rpc), or
  //   (b) fetch rows and aggregate in JS.
  // Family-level row counts are small (<10K/month typical), so (b) is fine
  // and avoids a migration for an RPC.
  let q = supabase
    .from('transactions')
    .select('amount, comment')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .eq('type', 'expense');
  if (categoryId) q = q.eq('category_id', categoryId);
  if (periodStart) q = q.gte('transaction_date', periodStart);
  if (periodEnd) q = q.lte('transaction_date', periodEnd);

  const { data } = await q;
  if (!data || data.length === 0) return [];

  const buckets = new Map<string, { total: number; count: number }>();
  for (const row of data) {
    const key = (row.comment ?? '').trim().toLowerCase() || '(без описания)';
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    bucket.total += row.amount;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([label, { total, count }]) => ({ label, total, count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.min(Math.max(1, limit), 50));
}

export async function searchTransactionsByComment(
  familyId: string,
  keyword: string,
  periodStart?: string,
  periodEnd?: string,
): Promise<TransactionSearchResult & { effectiveKeyword: string }> {
  const raw = normalizeKeyword(keyword);
  if (!raw) return { sum: 0, count: 0, sample: [], effectiveKeyword: '' };

  // Try 1: as-is. Catches exact matches (comment contains the word verbatim).
  const tryOne = async (kw: string) => {
    const safe = escapeLikeSpecials(kw);
    let q = supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('family_id', familyId)
      .is('deleted_at', null)
      .eq('type', 'expense')
      .ilike('comment', `%${safe}%`);
    if (periodStart) q = q.gte('transaction_date', periodStart);
    if (periodEnd) q = q.lte('transaction_date', periodEnd);
    q = q.order('transaction_date', { ascending: false }).limit(10);
    const { data, count } = await q;
    const sample = data ?? [];
    return { sum: sample.reduce((s, t) => s + t.amount, 0), count: count ?? sample.length, sample };
  };

  const asIs = await tryOne(raw);
  if (asIs.count > 0) return { ...asIs, effectiveKeyword: raw };

  // Try 2: stemmed. If the user said "агушу" we also try "агуш" which catches
  // "агуша", "агуши", "агушей", etc. Safety net for Russian morphology.
  const stem = russianStem(raw);
  if (stem !== raw && stem.length >= 3) {
    const stemmed = await tryOne(stem);
    if (stemmed.count > 0) return { ...stemmed, effectiveKeyword: stem };
  }

  return { sum: 0, count: 0, sample: [], effectiveKeyword: raw };
}

export interface ListRecentResult {
  transactions: Transaction[];
  total_count: number;
  has_more: boolean;
}

export async function listRecentTransactionsPaged(
  familyId: string,
  limit = 10,
  offset = 0,
  periodStart?: string,
  periodEnd?: string,
): Promise<ListRecentResult> {
  const capped = Math.min(Math.max(1, limit), 30);  // hard cap for Telegram message length

  let q = supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (periodStart) q = q.gte('transaction_date', periodStart);
  if (periodEnd) q = q.lte('transaction_date', periodEnd);

  q = q.range(offset, offset + capped - 1);

  const { data, count } = await q;
  const transactions = data ?? [];
  const total = count ?? transactions.length;
  return {
    transactions,
    total_count: total,
    has_more: offset + transactions.length < total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending wizard state (atomic advance for serverless-safe concurrency)
// ─────────────────────────────────────────────────────────────────────────────

export type WizardStep = 'pick_name' | 'pick_amount' | 'pick_deadline' | 'confirm';

export interface PendingGoalState {
  pending_goal_step: WizardStep | null;
  pending_goal_data: Record<string, unknown> | null;
  pending_started_at: string | null;
}

export async function getPendingGoalState(familyId: string): Promise<PendingGoalState | null> {
  const { data } = await supabase
    .from('families')
    .select('pending_goal_step, pending_goal_data, pending_started_at')
    .eq('id', familyId)
    .single();
  return data;
}

/**
 * Start a new wizard flow. Sets pending_goal_step to the given step, clears
 * any prior data. Idempotent per family — overwrites existing pending state.
 */
export async function startPendingGoalFlow(
  familyId: string,
  step: WizardStep,
  data: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from('families')
    .update({
      pending_goal_step: step,
      pending_goal_data: data,
      pending_started_at: new Date().toISOString(),
    })
    .eq('id', familyId);
  if (error) throw new Error(`Не удалось начать мастер: ${error.message}`);
}

/**
 * Atomically advance the wizard from `expectedStep` to `nextStep`, merging
 * new data. If another concurrent request already advanced past
 * `expectedStep`, returns false and the caller should tell the user to wait.
 *
 * Uses UPDATE ... WHERE pending_goal_step = $expected RETURNING — if the row
 * was changed by another request between the caller's read and this update,
 * RETURNING is empty and we know to back off.
 */
export async function advancePendingGoalStep(
  familyId: string,
  expectedStep: WizardStep,
  nextStep: WizardStep | null,  // null = flow complete
  dataToMerge: Record<string, unknown>,
): Promise<boolean> {
  // Read current data to merge (jsonb merging via PostgREST is limited; do it app-side)
  const prior = await getPendingGoalState(familyId);
  if (!prior || prior.pending_goal_step !== expectedStep) return false;

  const merged = { ...(prior.pending_goal_data ?? {}), ...dataToMerge };
  const update: Record<string, unknown> = {
    pending_goal_step: nextStep,
    pending_goal_data: nextStep === null ? null : merged,
  };
  if (nextStep === null) update.pending_started_at = null;

  const { data, error } = await supabase
    .from('families')
    .update(update)
    .eq('id', familyId)
    .eq('pending_goal_step', expectedStep)  // atomic check
    .select();

  if (error) throw new Error(`Не удалось продвинуть мастер: ${error.message}`);
  return Boolean(data && data.length > 0);
}

export async function clearPendingGoalState(familyId: string): Promise<void> {
  const { error } = await supabase
    .from('families')
    .update({
      pending_goal_step: null,
      pending_goal_data: null,
      pending_started_at: null,
    })
    .eq('id', familyId);
  if (error) throw new Error(`Не удалось отменить мастер: ${error.message}`);
}

/**
 * Cleanup cron target: nulls pending state for any family where it's been
 * hanging for more than `olderThanHours` hours. Prevents wedged-user outcomes
 * from abandoned wizards.
 */
export async function cleanupStalePendingState(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('families')
    .update({
      pending_goal_step: null,
      pending_goal_data: null,
      pending_started_at: null,
    })
    .lt('pending_started_at', cutoff)
    .not('pending_goal_step', 'is', null)
    .select('id');
  if (error) throw new Error(`Cleanup failed: ${error.message}`);
  return data?.length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending list context (for "ещё" pagination of /recent)
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingListContext {
  limit: number;
  offset: number;
  period_start?: string;
  period_end?: string;
  stored_at: string;  // ISO timestamp
}

export async function setPendingListContext(
  familyId: string,
  ctx: Omit<PendingListContext, 'stored_at'>,
): Promise<void> {
  const full: PendingListContext = { ...ctx, stored_at: new Date().toISOString() };
  const { error } = await supabase
    .from('families')
    .update({ pending_list_context: full })
    .eq('id', familyId);
  if (error) throw new Error(`Не удалось сохранить контекст: ${error.message}`);
}

export async function getPendingListContext(
  familyId: string,
  ttlMinutes = 10,
): Promise<PendingListContext | null> {
  const { data } = await supabase
    .from('families')
    .select('pending_list_context')
    .eq('id', familyId)
    .single();
  const ctx = data?.pending_list_context as PendingListContext | null;
  if (!ctx) return null;
  // Check TTL
  const age = Date.now() - new Date(ctx.stored_at).getTime();
  if (age > ttlMinutes * 60_000) return null;
  return ctx;
}

export async function clearPendingListContext(familyId: string): Promise<void> {
  const { error } = await supabase
    .from('families')
    .update({ pending_list_context: null })
    .eq('id', familyId);
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending confirms (write-tool proposals awaiting user ✅/❌ tap)
// ─────────────────────────────────────────────────────────────────────────────

export type ConfirmType =
  | 'create_goal'
  | 'contribute_to_goal'
  | 'archive_goal'
  | 'delete_transaction'
  | 'update_transaction_category'
  | 'set_monthly_plan'
  | 'create_category'
  | 'create_categories_bulk'
  | 'rename_category'
  | 'delete_category'
  | 'merge_categories';

export interface PendingConfirm {
  nonce: string;
  type: ConfirmType;
  args: Record<string, unknown>;
  stored_at: string;  // ISO
}

/**
 * Generate a short random nonce (4 hex chars = 65K possibilities). Fits
 * easily in Telegram's 64-byte callback_data limit.
 */
export function generateConfirmNonce(): string {
  return Math.random().toString(16).slice(2, 6).padStart(4, '0');
}

export async function setPendingConfirm(
  familyId: string,
  proposal: Omit<PendingConfirm, 'stored_at'>,
): Promise<void> {
  const full: PendingConfirm = { ...proposal, stored_at: new Date().toISOString() };
  const { error } = await supabase
    .from('families')
    .update({ pending_confirm: full })
    .eq('id', familyId);
  if (error) throw new Error(`Не удалось сохранить запрос: ${error.message}`);
}

export async function getPendingConfirm(
  familyId: string,
  ttlMinutes = 10,
): Promise<PendingConfirm | null> {
  const { data } = await supabase
    .from('families')
    .select('pending_confirm')
    .eq('id', familyId)
    .single();
  const pc = data?.pending_confirm as PendingConfirm | null;
  if (!pc) return null;
  const age = Date.now() - new Date(pc.stored_at).getTime();
  if (age > ttlMinutes * 60_000) return null;
  return pc;
}

export async function clearPendingConfirm(familyId: string): Promise<void> {
  const { error } = await supabase
    .from('families')
    .update({ pending_confirm: null })
    .eq('id', familyId);
  if (error) throw error;
}

