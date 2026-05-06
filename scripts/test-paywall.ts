// Direct gate test: bypass HTTP/Telegram and call checkPaidStatus against dev.
// Refuses to run against prod by URL check.
import { createClient } from '@supabase/supabase-js';
import { checkPaidStatus } from '../src/lib/bot/paywall';

async function main() {
  const url = process.env.SUPABASE_URL!;
  if (!url.includes('rcpuvqjrtxyuvmnjandm')) {
    throw new Error(`Refusing to run: SUPABASE_URL is not dev. Got: ${url}`);
  }
  const sb = createClient(url, process.env.SUPABASE_SERVICE_KEY!);

  const TEST_FAMILY = '8bd20a5a-1b1e-45ff-a9dc-579098f62842';

  // Scenario 1: family with far-future paid_until → allowed
  await sb.from('families').update({ paid_until: '2099-01-01T00:00:00Z' }).eq('id', TEST_FAMILY);
  const s1 = await checkPaidStatus(TEST_FAMILY);
  console.log('Far-future:', s1);
  if (!s1.allowed) throw new Error('expected allowed for 2099 paid_until');

  // Scenario 2: family with past paid_until → blocked
  const yesterday = new Date(Date.now() - 86400_000).toISOString();
  await sb.from('families').update({ paid_until: yesterday }).eq('id', TEST_FAMILY);
  const s2 = await checkPaidStatus(TEST_FAMILY);
  console.log('Past:', s2);
  if (s2.allowed) throw new Error('expected blocked for past paid_until');
  if (s2.daysExpired !== 1) throw new Error(`expected 1 day expired, got ${s2.daysExpired}`);

  // Scenario 3: missing family → blocked (defensive)
  const s3 = await checkPaidStatus('00000000-aaaa-bbbb-cccc-000000000000');
  console.log('Missing:', s3);
  if (s3.allowed) throw new Error('expected blocked for missing family');

  // Restore Test Family to far-future for downstream tests
  await sb.from('families').update({ paid_until: '2099-01-01T00:00:00Z' }).eq('id', TEST_FAMILY);

  console.log('\n✓ All paywall gate scenarios pass.');
}
main().catch((e) => { console.error(e); process.exit(1); });
