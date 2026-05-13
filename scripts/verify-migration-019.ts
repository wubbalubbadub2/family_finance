// Verify migration 019 applied cleanly on dev.
// Creates a synthetic test family + a test transaction, calls
// soft_wipe_family_data, asserts the soft-wipe effects, then cleans up.
//
// SAFETY:
//   - Uses a fresh test family with a clearly-fake name "TEST_019_VERIFY_DELETE_ME"
//   - Hard-deletes its rows at the end (all test data, no real customer touched)
//   - Read-only against any real family
//
// Run:
//   npx tsx --env-file=.env.dev.local scripts/verify-migration-019.ts

import { createClient } from '@supabase/supabase-js';

const TEST_TAG = 'TEST_019_VERIFY_DELETE_ME';

async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  console.log(`DB: ${process.env.SUPABASE_URL}`);
  console.log();

  // ── Step 1: confirm column exists ──
  const { error: probeErr } = await sb
    .from('families')
    .select('id, deleted_at')
    .limit(0);
  if (probeErr) {
    console.error('✗ deleted_at column missing:', probeErr.message);
    process.exit(1);
  }
  console.log('✓ families.deleted_at column exists');

  // ── Step 2: create synthetic family ──
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: fam, error: famErr } = await sb
    .from('families')
    .insert({ name: TEST_TAG, paid_until: future })
    .select('id')
    .single();
  if (famErr || !fam) { console.error('✗ family insert failed:', famErr); process.exit(1); }
  const familyId = fam.id as string;
  console.log(`✓ test family created: ${familyId}`);

  // We need a user_id for the transaction (FK). Insert a synthetic test user.
  const fakeTg = 999900000 + Math.floor(Math.random() * 99999);
  const { data: usr, error: usrErr } = await sb
    .from('users')
    .insert({ telegram_id: fakeTg, name: TEST_TAG, family_id: familyId })
    .select('id')
    .single();
  if (usrErr || !usr) { console.error('✗ user insert failed:', usrErr); process.exit(1); }
  const userId = usr.id as string;
  console.log(`✓ test user created: ${userId}`);

  // ── Step 3: insert a transaction so soft_wipe has something to mark ──
  // Need a category — find any existing one (or create one)
  const { data: anyCat } = await sb.from('categories').select('id').eq('family_id', familyId).limit(1);
  let categoryId: number;
  if (anyCat && anyCat.length > 0) {
    categoryId = anyCat[0].id;
  } else {
    // seedDefaultCategoriesForFamily not exposed; insert one manually
    const { data: newCat, error: catErr } = await sb
      .from('categories')
      .insert({ family_id: familyId, name: 'Тест', slug: 'test', emoji: '🧪', sort_order: 0 })
      .select('id')
      .single();
    if (catErr || !newCat) { console.error('✗ category insert failed:', catErr); process.exit(1); }
    categoryId = newCat.id;
  }

  const { data: tx, error: txErr } = await sb
    .from('transactions')
    .insert({
      user_id: userId,
      family_id: familyId,
      category_id: categoryId,
      type: 'expense',
      amount: 100,
      comment: TEST_TAG,
      source: 'telegram',
      transaction_date: new Date().toISOString().slice(0, 10),
    })
    .select('id')
    .single();
  if (txErr || !tx) { console.error('✗ transaction insert failed:', txErr); process.exit(1); }
  const txId = tx.id as string;
  console.log(`✓ test transaction created: ${txId}`);

  // ── Step 4: call the RPC ──
  console.log();
  console.log('Calling soft_wipe_family_data RPC...');
  const { data: rpcResult, error: rpcErr } = await sb.rpc('soft_wipe_family_data', { p_family_id: familyId });
  if (rpcErr) { console.error('✗ RPC failed:', rpcErr); process.exit(1); }
  console.log('✓ RPC returned:', JSON.stringify(rpcResult, null, 2));

  // ── Step 5: verify family.deleted_at set ──
  const { data: famAfter } = await sb.from('families').select('deleted_at').eq('id', familyId).single();
  if (!famAfter?.deleted_at) { console.error('✗ family.deleted_at NOT set'); process.exit(1); }
  console.log(`✓ family.deleted_at set: ${famAfter.deleted_at}`);

  // ── Step 6: verify transaction.deleted_at set ──
  const { data: txAfter } = await sb.from('transactions').select('deleted_at').eq('id', txId).single();
  if (!txAfter?.deleted_at) { console.error('✗ transaction.deleted_at NOT set'); process.exit(1); }
  console.log(`✓ transaction.deleted_at set: ${txAfter.deleted_at}`);

  // ── Step 7: verify audit row in bot_actions_log ──
  const { data: audit } = await sb
    .from('bot_actions_log')
    .select('source, family_id, meta')
    .eq('family_id', familyId)
    .eq('source', 'soft_wipe_family_data')
    .single();
  if (!audit) { console.error('✗ audit row missing'); process.exit(1); }
  console.log(`✓ audit row in bot_actions_log: meta=${JSON.stringify(audit.meta)}`);

  // ── Step 8: cleanup (hard-delete all test data) ──
  console.log();
  console.log('Cleanup...');
  await sb.from('bot_actions_log').delete().eq('family_id', familyId);
  await sb.from('transactions').delete().eq('family_id', familyId);
  await sb.from('users').delete().eq('family_id', familyId);
  await sb.from('categories').delete().eq('family_id', familyId);
  await sb.from('families').delete().eq('id', familyId);
  console.log('✓ test data hard-deleted');

  console.log();
  console.log('✅ Migration 019 verified.');
}
main().catch(e => { console.error(e); process.exit(1); });
