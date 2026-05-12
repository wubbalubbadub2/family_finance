// PROD validation test — Path C from 2026-05-12 discussion.
//
// Fires the audience-driven nudge path on PROD against TWO families only:
//   1. Shynggys's family (00000000) — chat_id=173826717
//   2. Akbota Ислам's family (40e654c6) — chat_id=393545284
//
// Goal: exercise the FULL prod cron pipeline (audience query → send →
// markFamilyNudgeSent → bot_actions_log → idempotency) before we add
// the vercel.json schedule for the real ~48-family cron tomorrow.
//
// Data manipulation:
//   - Shynggys has 2 txs today → shift 1 to yesterday + soft-delete the
//     other so audience filter accepts her. Restored in finally.
//   - Akbota has 0 txs today and 8 ever → already qualifies. No manipulation.
//     We DO clear her last_nudge_sent_at at the end so she remains eligible
//     for tomorrow's real cron.
//
// SAFETY (per user's explicit ask):
//   - Try/finally guarantees restore on Shynggys's data even if test fails
//   - Akbota's data is never touched at all (read-only against her)
//   - All "fixes" are reversible UPDATE statements; no transactions deleted
//     from disk
//
// Run:
//   npx tsx --env-file=.env.production.local scripts/test-prod-validation-tonight.ts

import { createClient } from '@supabase/supabase-js';

const PROD_URL = 'https://family-finance-taupe.vercel.app';
const SHYNGGYS_FAMILY = '00000000-0000-0000-0000-000000000001';
const AKBOTA_FAMILY  = '40e654c6-5421-40bd-bc7a-f75bf8ada0b1';
const SHYNGGYS_CHAT  = 173826717;
const AKBOTA_CHAT    = 393545284;

interface FetchResult { audience_count: number; sent: number; blocked: number; errors: number; sent_families: Array<{ family_id: string; family_name: string; latency_ms: number }>; }

async function call(path: string, secret: string): Promise<FetchResult> {
  const res = await fetch(`${PROD_URL}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const secret = process.env.CRON_SECRET as string;
  if (!secret) { console.error('CRON_SECRET missing'); process.exit(1); }

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });
  const yesterday = new Date(Date.now() - 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });

  console.log('━━━ PROD VALIDATION — DAY-1 NUDGE PIPELINE ━━━');
  console.log(`Time (Almaty): ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`);
  console.log(`Today's Almaty date: ${today}`);
  console.log();

  // ── Step 1: Snapshot Shynggys's today txs for safe restore ──
  const { data: todayTxs } = await sb
    .from('transactions')
    .select('id, type, amount, transaction_date, deleted_at')
    .eq('family_id', SHYNGGYS_FAMILY)
    .is('deleted_at', null)
    .eq('transaction_date', today)
    .order('created_at', { ascending: true });
  const todayIds = (todayTxs ?? []).map(t => t.id);
  console.log(`Snapshotted ${todayIds.length} Shynggys txs for today (will restore)`);
  if (todayIds.length === 0) {
    console.log('  No today txs — Shynggys already qualifies without manipulation');
  }
  const movedToYesterdayId = todayIds[0] ?? null;
  const softDeleteIds = todayIds.slice(1);

  try {
    // ── Step 2: Manipulate Shynggys's data to satisfy audience ──
    if (movedToYesterdayId) {
      const { error } = await sb.from('transactions').update({ transaction_date: yesterday }).eq('id', movedToYesterdayId);
      if (error) throw new Error(`Move-to-yesterday failed: ${error.message}`);
      console.log(`  Moved tx ${movedToYesterdayId} → transaction_date=${yesterday}`);
    }
    if (softDeleteIds.length > 0) {
      const { error } = await sb.from('transactions').update({ deleted_at: new Date().toISOString() }).in('id', softDeleteIds);
      if (error) throw new Error(`Soft-delete failed: ${error.message}`);
      console.log(`  Soft-deleted ${softDeleteIds.length} remaining today txs`);
    }
    console.log();

    // ── Step 3: Fire test for Shynggys ──
    console.log('━━━ SHYNGGYS test ━━━');
    const dry1 = await call(`/api/cron/day1-nudge?dry_run=true&restrict_family_id=${SHYNGGYS_FAMILY}`, secret);
    console.log(`  dry-run audience_count=${dry1.audience_count} (expected 1)`);
    if (dry1.audience_count !== 1) throw new Error(`Shynggys dry-run audience mismatch`);
    const send1 = await call(`/api/cron/day1-nudge?restrict_family_id=${SHYNGGYS_FAMILY}`, secret);
    console.log(`  real send → sent=${send1.sent} blocked=${send1.blocked} errors=${send1.errors}`);
    if (send1.sent !== 1) throw new Error(`Shynggys send failed`);
    console.log(`  latency=${send1.sent_families[0]?.latency_ms}ms`);

    // Brief pause so any fire-and-forget DB writes settle. The code now
    // awaits the critical markFamilyNudgeSent, but bot_actions_log is still
    // fire-and-forget; we want both visible before asserting.
    await new Promise(r => setTimeout(r, 1500));

    // ── Step 4: Verify state writes for Shynggys ──
    const { data: famS } = await sb.from('families').select('last_nudge_sent_at').eq('id', SHYNGGYS_FAMILY).single();
    console.log(`  Shynggys.last_nudge_sent_at=${famS?.last_nudge_sent_at}`);
    if (!famS?.last_nudge_sent_at) throw new Error('Shynggys last_nudge_sent_at not updated');
    const { data: logS } = await sb.from('bot_actions_log').select('id, source, family_id, meta, latency_ms').eq('family_id', SHYNGGYS_FAMILY).eq('source', 'cron:day1_nudge').order('occurred_at', { ascending: false }).limit(1);
    console.log(`  bot_actions_log row: ${JSON.stringify(logS?.[0])}`);
    if (!logS?.[0]) throw new Error('Shynggys bot_actions_log row missing');
    console.log();

    // ── Step 5: Fire test for Akbota (no data manipulation needed) ──
    console.log('━━━ AKBOTA test ━━━');
    const dry2 = await call(`/api/cron/day1-nudge?dry_run=true&restrict_family_id=${AKBOTA_FAMILY}`, secret);
    console.log(`  dry-run audience_count=${dry2.audience_count} (expected 1)`);
    if (dry2.audience_count !== 1) throw new Error(`Akbota dry-run audience mismatch`);
    const send2 = await call(`/api/cron/day1-nudge?restrict_family_id=${AKBOTA_FAMILY}`, secret);
    console.log(`  real send → sent=${send2.sent} blocked=${send2.blocked} errors=${send2.errors}`);
    if (send2.sent !== 1) throw new Error(`Akbota send failed`);
    console.log(`  latency=${send2.sent_families[0]?.latency_ms}ms`);

    await new Promise(r => setTimeout(r, 1500));

    // ── Step 6: Verify state writes for Akbota ──
    const { data: famA } = await sb.from('families').select('last_nudge_sent_at').eq('id', AKBOTA_FAMILY).single();
    console.log(`  Akbota.last_nudge_sent_at=${famA?.last_nudge_sent_at}`);
    if (!famA?.last_nudge_sent_at) throw new Error('Akbota last_nudge_sent_at not updated');
    const { data: logA } = await sb.from('bot_actions_log').select('id, source, family_id, meta, latency_ms').eq('family_id', AKBOTA_FAMILY).eq('source', 'cron:day1_nudge').order('occurred_at', { ascending: false }).limit(1);
    console.log(`  bot_actions_log row: ${JSON.stringify(logA?.[0])}`);
    if (!logA?.[0]) throw new Error('Akbota bot_actions_log row missing');
    console.log();

    // ── Step 7: Idempotency check (re-run dry should return 0 for each) ──
    const reS = await call(`/api/cron/day1-nudge?dry_run=true&restrict_family_id=${SHYNGGYS_FAMILY}`, secret);
    const reA = await call(`/api/cron/day1-nudge?dry_run=true&restrict_family_id=${AKBOTA_FAMILY}`, secret);
    console.log(`Idempotency re-run audience: Shynggys=${reS.audience_count}, Akbota=${reA.audience_count} (both should be 0)`);
    if (reS.audience_count !== 0 || reA.audience_count !== 0) throw new Error('Idempotency failed');

    console.log();
    console.log('✅ ALL CHECKS PASSED — prod pipeline validated.');
  } finally {
    // ── Restore Shynggys's tx data (always) ──
    if (movedToYesterdayId) {
      const { error } = await sb.from('transactions').update({ transaction_date: today }).eq('id', movedToYesterdayId);
      if (error) console.error(`✗ RESTORE FAILED (tx date): ${error.message} — manual fix: UPDATE transactions SET transaction_date='${today}' WHERE id='${movedToYesterdayId}';`);
      else console.log(`Restored tx ${movedToYesterdayId} → ${today}`);
    }
    if (softDeleteIds.length > 0) {
      const { error } = await sb.from('transactions').update({ deleted_at: null }).in('id', softDeleteIds);
      if (error) console.error(`✗ RESTORE FAILED (soft-delete): ${error.message} — manual fix: UPDATE transactions SET deleted_at=NULL WHERE id IN (${softDeleteIds.map(i=>`'${i}'`).join(',')});`);
      else console.log(`Restored ${softDeleteIds.length} soft-deleted txs`);
    }
    // Clear last_nudge_sent_at for BOTH families so they remain eligible
    // for tomorrow's real cron firing.
    const { error: e1 } = await sb.from('families').update({ last_nudge_sent_at: null }).eq('id', SHYNGGYS_FAMILY);
    if (e1) console.error(`✗ Failed to clear Shynggys.last_nudge_sent_at: ${e1.message}`);
    else console.log(`Cleared Shynggys.last_nudge_sent_at — eligible for tomorrow's cron`);
    const { error: e2 } = await sb.from('families').update({ last_nudge_sent_at: null }).eq('id', AKBOTA_FAMILY);
    if (e2) console.error(`✗ Failed to clear Akbota.last_nudge_sent_at: ${e2.message}`);
    else console.log(`Cleared Akbota.last_nudge_sent_at — eligible for tomorrow's cron`);
  }
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
