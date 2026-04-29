// One-shot migration: copy Shynggys + Akbota family data from the old
// Supabase prod project (bkbctxsycdvegdeysxgf, "tolagai-66" org, eu-central-1)
// into the new finance-copilot project (nzukbmohxdexzhryshap, ap-south-1).
//
// Usage:
//   DRY_RUN=1 node --import tsx scripts/migrate-old-to-new-prod.ts   (preview)
//   node --import tsx scripts/migrate-old-to-new-prod.ts             (execute)
//
// Run with both env files loaded:
//   set -a; source .env.local; OLD_URL=$SUPABASE_URL; OLD_KEY=$SUPABASE_SERVICE_KEY
//   source .env.prod.new.local; NEW_URL=$SUPABASE_URL; NEW_KEY=$SUPABASE_SERVICE_KEY
//   OLD_SUPABASE_URL=$OLD_URL OLD_SUPABASE_SERVICE_KEY=$OLD_KEY \
//   NEW_SUPABASE_URL=$NEW_URL NEW_SUPABASE_SERVICE_KEY=$NEW_KEY \
//     node --import tsx scripts/migrate-old-to-new-prod.ts
//
// Idempotent: each table uses upsert on id (or family_id+slug for categories).
// Re-running is safe; partial-failure recovery is just re-run.
//
// IMPORTANT: after this script reports success, run the follow-up SQL in the
// new project's SQL editor to advance BIGSERIAL sequences. Without it, future
// inserts of categories/etc will conflict with the IDs we just preserved.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const FAMILIES_TO_MIGRATE = [
  '00000000-0000-0000-0000-000000000001', // Shynggys Family
  '40e654c6-5421-40bd-bc7a-f75bf8ada0b1', // Akbota Family
];

const TABLES_TO_MIGRATE = [
  // In FK order: parent tables first.
  { name: 'families', conflict: 'id', filter: { col: 'id', list: FAMILIES_TO_MIGRATE } },
  { name: 'users', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'categories', conflict: 'family_id,slug', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'transactions', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'goals', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'goal_contributions', conflict: 'id', filter: { col: 'goal_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'monthly_plans', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'recurring_transactions', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'debts', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'category_overrides', conflict: 'family_id,keyword', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'family_invites', conflict: 'code', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
  { name: 'conversation_messages', conflict: 'id', filter: { col: 'family_id', list: FAMILIES_TO_MIGRATE } },
];

// Skipped intentionally:
//   error_log — stale errors don't help in new env; start fresh
//   merchant_category_map — categorizer cache, rebuilds itself

const DRY_RUN = process.env.DRY_RUN === '1';
const OLD_URL = required('OLD_SUPABASE_URL');
const OLD_KEY = required('OLD_SUPABASE_SERVICE_KEY');
const NEW_URL = required('NEW_SUPABASE_URL');
const NEW_KEY = required('NEW_SUPABASE_SERVICE_KEY');

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function migrateTable(
  oldDb: SupabaseClient,
  newDb: SupabaseClient,
  tbl: typeof TABLES_TO_MIGRATE[number],
): Promise<{ read: number; written: number }> {
  // Build the filter list. Most tables have a direct family_id; goal_contributions
  // joins via goal_id, so we resolve that to goal IDs first.
  let filterList: (string | number)[] = tbl.filter.list as (string | number)[];
  if (tbl.name === 'goal_contributions' && tbl.filter.col === 'goal_id') {
    const { data: goals } = await oldDb
      .from('goals').select('id')
      .in('family_id', FAMILIES_TO_MIGRATE);
    filterList = (goals ?? []).map((g: { id: string }) => g.id);
    if (filterList.length === 0) return { read: 0, written: 0 };
  }

  const { data: rows, error: readErr } = await oldDb
    .from(tbl.name)
    .select('*')
    .in(tbl.filter.col, filterList);
  if (readErr) throw new Error(`[${tbl.name}] read failed: ${readErr.message}`);
  const sourceRows = rows ?? [];

  if (sourceRows.length === 0) return { read: 0, written: 0 };

  if (DRY_RUN) {
    console.log(`  ${tbl.name}: would migrate ${sourceRows.length} rows`);
    return { read: sourceRows.length, written: 0 };
  }

  // Upsert in chunks to avoid Postgres parameter limits on large tables
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < sourceRows.length; i += CHUNK) {
    const chunk = sourceRows.slice(i, i + CHUNK);
    const { error: writeErr, count } = await newDb
      .from(tbl.name)
      .upsert(chunk, { onConflict: tbl.conflict, count: 'exact' });
    if (writeErr) throw new Error(`[${tbl.name}] upsert chunk ${i / CHUNK} failed: ${writeErr.message}`);
    written += count ?? chunk.length;
  }

  return { read: sourceRows.length, written };
}

async function verifyCounts(
  oldDb: SupabaseClient,
  newDb: SupabaseClient,
  tbl: typeof TABLES_TO_MIGRATE[number],
): Promise<{ old: number; new_: number; match: boolean }> {
  // Mirror migrateTable's special case for goal_contributions
  let filterList: (string | number)[] = tbl.filter.list as (string | number)[];
  if (tbl.name === 'goal_contributions' && tbl.filter.col === 'goal_id') {
    const { data: goals } = await oldDb
      .from('goals').select('id')
      .in('family_id', FAMILIES_TO_MIGRATE);
    filterList = (goals ?? []).map((g: { id: string }) => g.id);
    if (filterList.length === 0) return { old: 0, new_: 0, match: true };
  }
  const { count: oldCount } = await oldDb
    .from(tbl.name).select('*', { count: 'exact', head: true })
    .in(tbl.filter.col, filterList);
  const { count: newCount } = await newDb
    .from(tbl.name).select('*', { count: 'exact', head: true })
    .in(tbl.filter.col, filterList);
  return { old: oldCount ?? 0, new_: newCount ?? 0, match: (oldCount ?? 0) === (newCount ?? 0) };
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? '🔍 DRY RUN — no writes will happen' : '📦 LIVE — writing to new prod');
  console.log('Old prod:', OLD_URL);
  console.log('New prod:', NEW_URL);
  console.log('Families:', FAMILIES_TO_MIGRATE.join(', '));
  console.log('');

  const oldDb = createClient(OLD_URL, OLD_KEY);
  const newDb = createClient(NEW_URL, NEW_KEY);

  console.log('=== Migrating tables ===');
  const summary: Array<{ table: string; read: number; written: number }> = [];
  for (const tbl of TABLES_TO_MIGRATE) {
    process.stdout.write(`  ${tbl.name}... `);
    const { read, written } = await migrateTable(oldDb, newDb, tbl);
    console.log(`read ${read}, ${DRY_RUN ? 'would write' : 'written'} ${written}`);
    summary.push({ table: tbl.name, read, written });
  }

  if (DRY_RUN) {
    console.log('');
    console.log('Dry run complete. Re-run without DRY_RUN=1 to execute.');
    return;
  }

  console.log('');
  console.log('=== Verifying row counts ===');
  let allMatch = true;
  for (const tbl of TABLES_TO_MIGRATE) {
    const { old, new_, match } = await verifyCounts(oldDb, newDb, tbl);
    const tag = match ? '✓' : '✗';
    console.log(`  ${tag} ${tbl.name}: old=${old} new=${new_}`);
    if (!match) allMatch = false;
  }

  if (!allMatch) {
    console.error('');
    console.error('⚠️ Some counts mismatch. Investigate before proceeding.');
    process.exit(1);
  }

  console.log('');
  console.log("✅ All row counts match. Run this SQL in the NEW prod's SQL editor:");
  console.log('');
  console.log("-- Advance BIGSERIAL sequences past migrated max ids so future inserts don't conflict");
  console.log("SELECT setval(pg_get_serial_sequence('categories', 'id'), COALESCE((SELECT MAX(id) FROM categories), 1));");
  console.log("SELECT setval(pg_get_serial_sequence('merchant_category_map', 'id'), COALESCE((SELECT MAX(id) FROM merchant_category_map), 1));");
  console.log("SELECT setval(pg_get_serial_sequence('error_log', 'id'), COALESCE((SELECT MAX(id) FROM error_log), 1));");
  console.log("SELECT setval(pg_get_serial_sequence('conversation_messages', 'id'), COALESCE((SELECT MAX(id) FROM conversation_messages), 1));");
}

main().catch((e) => {
  console.error('❌ Migration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
