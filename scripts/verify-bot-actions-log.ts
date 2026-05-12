// Verifies bot_actions_log table after migration 017 is applied.
//
// What it does (read-only by default):
//   1. SELECT … LIMIT 0 to confirm the table + all columns exist
//   2. Synthetic INSERT (source='test:verify-migration-017') so we know
//      writes work end-to-end with the service-role key
//   3. SELECT the inserted row back, print the shape
//   4. DELETE the synthetic row (always — leaves no test pollution)
//
// SAFETY:
//   - No real data touched. Only inserts and deletes one row with source
//     'test:verify-migration-017'. If the script crashes mid-run, the row
//     is easy to identify and clean by hand:
//       DELETE FROM bot_actions_log WHERE source = 'test:verify-migration-017';
//
// Run against DEV:
//   npx tsx --env-file=.env.dev.local scripts/verify-bot-actions-log.ts
//
// Run against PROD (after user approval):
//   npx tsx --env-file=.env.production.local scripts/verify-bot-actions-log.ts

import { supabase } from '../src/lib/db/supabase';

const TEST_SOURCE = 'test:verify-migration-017';

async function main() {
  console.log(`Connecting to: ${process.env.SUPABASE_URL}`);
  console.log();

  // ─── Step 1: does the table exist? ───
  console.log('1. Checking table exists + columns are present …');
  const { error: selectErr } = await supabase
    .from('bot_actions_log')
    .select('id, occurred_at, family_id, source, tool_names, iterations, reply_length, latency_ms, input_tokens, output_tokens, cache_read, cache_write, meta')
    .limit(0);
  if (selectErr) {
    console.error('   ✗ FAILED:', selectErr.message);
    console.error('   Did you paste supabase/migrations/017_bot_actions_log.sql into Supabase SQL editor?');
    process.exit(1);
  }
  console.log('   ✓ Table exists with all 13 columns');

  // ─── Step 2: synthetic insert ───
  console.log();
  console.log('2. Synthetic insert (source=' + TEST_SOURCE + ') …');
  const { data: inserted, error: insertErr } = await supabase
    .from('bot_actions_log')
    .insert({
      source: TEST_SOURCE,
      family_id: null,
      tool_names: ['log_expense', 'list_recent'],
      iterations: 2,
      reply_length: 142,
      latency_ms: 3140,
      input_tokens: 4500,
      output_tokens: 320,
      cache_read: 4016,
      cache_write: 0,
      meta: { exit: 'reply', test: true, hallucination: false },
    })
    .select()
    .single();
  if (insertErr || !inserted) {
    console.error('   ✗ FAILED:', insertErr?.message);
    process.exit(1);
  }
  console.log('   ✓ Insert succeeded, id=' + inserted.id);

  // ─── Step 3: read it back ───
  console.log();
  console.log('3. Reading row back …');
  const { data: row, error: readErr } = await supabase
    .from('bot_actions_log')
    .select('*')
    .eq('id', inserted.id)
    .single();
  if (readErr || !row) {
    console.error('   ✗ FAILED:', readErr?.message);
    process.exit(1);
  }
  console.log('   ✓ Read back row:');
  console.log('     ', JSON.stringify(row, null, 2).split('\n').join('\n      '));

  // ─── Step 4: cleanup ───
  console.log();
  console.log('4. Deleting synthetic row …');
  const { error: delErr } = await supabase
    .from('bot_actions_log')
    .delete()
    .eq('id', inserted.id);
  if (delErr) {
    console.error('   ✗ FAILED to delete (manual cleanup needed):', delErr.message);
    process.exit(1);
  }
  console.log('   ✓ Deleted');

  console.log();
  console.log('✅ bot_actions_log is healthy.');
}

main().catch(e => { console.error(e); process.exit(1); });
