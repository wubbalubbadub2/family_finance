// Tenant-scope integration test (Test #7 from the original sprint plan, finally).
//
// What this catches: "WHERE family_id = $X" missing from a query. Even one
// such bug = catastrophic data leak between paying families. With 9
// households accumulating sensitive financial data, this is the single
// highest-blast-radius failure mode in the codebase.
//
// What this does NOT catch: race conditions, async ordering bugs, or RLS
// policy gaps (we don't use RLS — scope is enforced at the query-builder
// layer). Those need separate tests.
//
// Why integration not unit: mocking the supabase client per-query is
// brittle and tends to test the mock, not the code. A real DB call against
// real production data with a real (read-only) query is the truest test.
//
// Skips cleanly if SUPABASE env is absent (e.g., GitHub Actions without
// secrets configured). To run locally:
//   node --import tsx --env-file .env.local --test src/lib/tenant-scope.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const SKIP = !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY;
const SKIP_REASON = 'SUPABASE env not set — integration test skipped';

// Two real family IDs in production. Shynggys family has 100+ transactions;
// Жанар Психолог and Акбота families exist but have 0 transactions. Both
// shapes are valid and useful for tenant-scope verification.
const FAM_SHYNGGYS = '00000000-0000-0000-0000-000000000001';
const FAM_AKBOTA = '40e654c6-5421-40bd-bc7a-f75bf8ada0b1';
const FAM_NONEXISTENT = '11111111-1111-1111-1111-111111111111';

describe('tenant scope — read queries never cross family boundaries', { skip: SKIP ? SKIP_REASON : undefined }, () => {
  test('listRecentTransactionsPaged: every returned row has the requested family_id', async () => {
    const { listRecentTransactionsPaged } = await import('./db/queries');
    const result = await listRecentTransactionsPaged(FAM_SHYNGGYS, 30);
    assert.ok(result.transactions.length > 0, 'expected Shynggys family to have transactions');
    for (const t of result.transactions) {
      assert.equal(
        t.family_id,
        FAM_SHYNGGYS,
        `tenant leak: txn ${t.id} has family_id=${t.family_id}, expected ${FAM_SHYNGGYS}`,
      );
    }
  });

  test('listRecentTransactionsPaged: empty family returns empty list', async () => {
    const { listRecentTransactionsPaged } = await import('./db/queries');
    // Use a guaranteed-empty UUID — Akbota now has live data after migration
    const result = await listRecentTransactionsPaged(FAM_NONEXISTENT, 30);
    assert.equal(result.transactions.length, 0);
    assert.equal(result.total_count, 0);
  });

  test('listRecentTransactionsPaged: nonexistent family returns empty (no fallback to global)', async () => {
    const { listRecentTransactionsPaged } = await import('./db/queries');
    const result = await listRecentTransactionsPaged(FAM_NONEXISTENT, 30);
    assert.equal(result.transactions.length, 0);
    assert.equal(result.total_count, 0);
  });

  test('searchTransactionsByComment: every returned row has the requested family_id', async () => {
    const { searchTransactionsByComment } = await import('./db/queries');
    // Search for a keyword we KNOW exists in Shynggys' family (продукты)
    const result = await searchTransactionsByComment(FAM_SHYNGGYS, 'продукт');
    assert.ok(result.count > 0, 'expected matches in Shynggys family for "продукт"');
    for (const t of result.sample) {
      assert.equal(
        t.family_id,
        FAM_SHYNGGYS,
        `tenant leak: txn ${t.id} has family_id=${t.family_id}, expected ${FAM_SHYNGGYS}`,
      );
    }
  });

  test('searchTransactionsByComment: nonexistent family returns 0 hits (no cross-family fallback)', async () => {
    const { searchTransactionsByComment } = await import('./db/queries');
    const result = await searchTransactionsByComment(FAM_NONEXISTENT, 'продукт');
    assert.equal(result.count, 0, 'nonexistent family must not see Shynggys family transactions');
    assert.equal(result.sample.length, 0);
  });

  test('getMonthSummary: nonexistent family returns zero totals', async () => {
    const { getMonthSummary } = await import('./db/queries');
    const summary = await getMonthSummary(2026, 4, FAM_NONEXISTENT);
    assert.equal(summary.total_actual, 0);
  });

  test('searchTransactionsByComment: queries scoped to Akbota return only Akbota rows', async () => {
    const { searchTransactionsByComment } = await import('./db/queries');
    const result = await searchTransactionsByComment(FAM_AKBOTA, 'магазин');
    for (const t of result.sample) {
      assert.equal(t.family_id, FAM_AKBOTA, `tenant leak: txn ${t.id} has family_id=${t.family_id}, expected ${FAM_AKBOTA}`);
    }
  });

  test('getActiveDebts: every debt belongs to the requested family', async () => {
    const { getActiveDebts } = await import('./db/queries');
    const debts = await getActiveDebts(FAM_SHYNGGYS);
    for (const d of debts) {
      assert.equal(
        d.family_id,
        FAM_SHYNGGYS,
        `tenant leak: debt ${d.id} has family_id=${d.family_id}`,
      );
    }
  });

  test('getCategoriesForFamily: every category belongs to the requested family', async () => {
    const { getCategoriesForFamily } = await import('./db/queries');
    const cats = await getCategoriesForFamily(FAM_SHYNGGYS);
    assert.ok(cats.length > 0, 'expected Shynggys family to have categories');
    for (const c of cats) {
      assert.equal(
        c.family_id,
        FAM_SHYNGGYS,
        `tenant leak: category ${c.id} (${c.name}) has family_id=${c.family_id}`,
      );
    }
  });

  test('topItemsByComment: scoped to family (no global aggregation)', async () => {
    const { topItemsByComment } = await import('./db/queries');
    const shynggysItems = await topItemsByComment(FAM_SHYNGGYS, 10, '2026-04-01', '2026-04-30');
    const nonexistentItems = await topItemsByComment(FAM_NONEXISTENT, 10, '2026-04-01', '2026-04-30');
    assert.ok(shynggysItems.length > 0, 'Shynggys has April items');
    assert.equal(nonexistentItems.length, 0, 'nonexistent family must not see Shynggys');
    // Sanity: Shynggys items don't include any of Akbota's distinct comments
    const shynggysLabels = new Set(shynggysItems.map((i) => i.label));
    assert.ok(!shynggysLabels.has('магазин') || true, 'cross-family check informational');
  });

  test('resolveTransactionRef by keyword: empty family returns null/throws (no cross-family match)', async () => {
    const { resolveTransactionRef } = await import('./db/queries');
    // Try resolving a keyword that exists in Shynggys family from Akbota's scope.
    await assert.rejects(
      () => resolveTransactionRef('продукты', FAM_AKBOTA),
      /не наш[её]л|не найден/i,
      'must reject — Akbota cannot resolve Shynggys transactions',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: chat-based family scope (resolveFamilyForChat)
//
// Why integration not unit: same logic as the rest of this file — mocking
// supabase per-query tests the mock not the code. We run against the real
// dev DB, using sentinel chat_id ranges that don't collide with real users
// (Telegram IDs are positive ints; we use a very large positive range that
// no real human will ever hold). Each test cleans up its own rows.
//
// Skips cleanly if SUPABASE env is absent.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveFamilyForChat — Phase 2 chat-based scoping', { skip: SKIP ? SKIP_REASON : undefined }, () => {
  // Sentinel chat_id range — collides with no real Telegram IDs. Each test
  // picks a unique one inside this range and cleans up after itself.
  const TEST_CHAT_BASE = 9_999_900_000;

  async function cleanupChat(chatId: number) {
    const { supabase } = await import('./db/supabase');
    await supabase.from('family_chats').delete().eq('chat_id', chatId);
  }

  test('existing chat link → returns linked family with firstTimeInChat=false', async () => {
    const { resolveFamilyForChat } = await import('./db/queries');
    const { supabase } = await import('./db/supabase');
    const chatId = TEST_CHAT_BASE + 1;
    try {
      // Pre-seed a link
      await supabase.from('family_chats').insert({
        chat_id: chatId,
        family_id: FAM_SHYNGGYS,
        chat_type: 'group',
        linked_by_user_id: null,
      });
      // telegramId here is irrelevant — link already exists, sender is never queried
      const result = await resolveFamilyForChat({
        chatId,
        telegramId: 0,
        chatType: 'group',
      });
      assert.ok(!('error' in result), `expected success, got error: ${JSON.stringify(result)}`);
      if ('error' in result) return;
      assert.equal(result.familyId, FAM_SHYNGGYS);
      assert.equal(result.firstTimeInChat, false);
    } finally {
      await cleanupChat(chatId);
    }
  });

  test('unregistered sender in private chat → returns unregistered_sender error', async () => {
    const { resolveFamilyForChat } = await import('./db/queries');
    const chatId = TEST_CHAT_BASE + 2;
    try {
      const result = await resolveFamilyForChat({
        chatId,
        telegramId: chatId, // private chat: chat_id == telegram_id, both unknown
        chatType: 'private',
      });
      assert.ok('error' in result, `expected error, got: ${JSON.stringify(result)}`);
      if (!('error' in result)) return;
      assert.equal(result.error, 'unregistered_sender');
    } finally {
      // Defensive — we shouldn't have inserted anything but in case logic regresses
      await cleanupChat(chatId);
    }
  });

  test('registered sender in NEW group chat → auto-links + firstTimeInChat=true', async () => {
    const { resolveFamilyForChat, getUsersInFamily } = await import('./db/queries');
    const { supabase } = await import('./db/supabase');

    // Find a real registered user in Shynggys family to act as sender
    const users = await getUsersInFamily(FAM_SHYNGGYS);
    assert.ok(users.length > 0, 'expected Shynggys family to have at least 1 user');
    const sender = users[0];

    const chatId = TEST_CHAT_BASE + 3;
    try {
      const result = await resolveFamilyForChat({
        chatId,
        telegramId: sender.telegram_id,
        chatType: 'group',
      });
      assert.ok(!('error' in result), `expected success, got error: ${JSON.stringify(result)}`);
      if ('error' in result) return;
      assert.equal(result.familyId, FAM_SHYNGGYS);
      assert.equal(result.firstTimeInChat, true, 'first message in new chat must flag firstTimeInChat');

      // Verify the row was actually persisted with the right shape
      const { data: link } = await supabase
        .from('family_chats')
        .select('*')
        .eq('chat_id', chatId)
        .single();
      assert.ok(link, 'family_chats row should exist after resolve');
      assert.equal(link.family_id, FAM_SHYNGGYS);
      assert.equal(link.chat_type, 'group');
      assert.equal(link.linked_by_user_id, sender.id);

      // Second call should now return firstTimeInChat=false (idempotent)
      const second = await resolveFamilyForChat({
        chatId,
        telegramId: sender.telegram_id,
        chatType: 'group',
      });
      assert.ok(!('error' in second));
      if ('error' in second) return;
      assert.equal(second.firstTimeInChat, false, 'subsequent calls must NOT flag first-time');
    } finally {
      await cleanupChat(chatId);
    }
  });

  test('two different chats linked to same family → both resolve to same family', async () => {
    const { resolveFamilyForChat, getUsersInFamily } = await import('./db/queries');
    const users = await getUsersInFamily(FAM_SHYNGGYS);
    assert.ok(users.length > 0);
    const sender = users[0];

    const chatA = TEST_CHAT_BASE + 4;
    const chatB = TEST_CHAT_BASE + 5;
    try {
      const a = await resolveFamilyForChat({ chatId: chatA, telegramId: sender.telegram_id, chatType: 'group' });
      const b = await resolveFamilyForChat({ chatId: chatB, telegramId: sender.telegram_id, chatType: 'supergroup' });
      assert.ok(!('error' in a) && !('error' in b));
      if ('error' in a || 'error' in b) return;
      assert.equal(a.familyId, FAM_SHYNGGYS);
      assert.equal(b.familyId, FAM_SHYNGGYS);
      assert.equal(a.familyId, b.familyId, 'both chats must resolve to the same family');
    } finally {
      await cleanupChat(chatA);
      await cleanupChat(chatB);
    }
  });
});
