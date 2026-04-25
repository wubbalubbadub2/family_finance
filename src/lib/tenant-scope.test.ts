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
    const result = await listRecentTransactionsPaged(FAM_AKBOTA, 30);
    assert.equal(result.transactions.length, 0, 'Akbota family must have 0 transactions');
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

  test('searchTransactionsByComment: empty family with same keyword returns 0 hits', async () => {
    const { searchTransactionsByComment } = await import('./db/queries');
    // Akbota family has 0 transactions, so any search must return 0.
    const result = await searchTransactionsByComment(FAM_AKBOTA, 'продукт');
    assert.equal(result.count, 0, 'Akbota family must not see Shynggys family transactions');
    assert.equal(result.sample.length, 0);
  });

  test('getMonthSummary: empty family returns zero totals', async () => {
    const { getMonthSummary } = await import('./db/queries');
    const summary = await getMonthSummary(2026, 4, FAM_AKBOTA);
    assert.equal(summary.total_actual, 0, 'Akbota family must have 0 spending this month');
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
    const akbotaItems = await topItemsByComment(FAM_AKBOTA, 10, '2026-04-01', '2026-04-30');
    assert.ok(shynggysItems.length > 0, 'Shynggys has April items');
    assert.equal(akbotaItems.length, 0, 'Akbota has zero April items — must not see Shynggys');
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
