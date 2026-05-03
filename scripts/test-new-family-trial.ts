// Verify createFamily() (used by bot /newfamily) sets paid_until = now + 3 days.
// Refuses to run against prod by URL check.
import { createClient } from '@supabase/supabase-js';
import { createFamily } from '../src/lib/db/queries';

async function main() {
  const url = process.env.SUPABASE_URL!;
  if (!url.includes('rcpuvqjrtxyuvmnjandm')) {
    throw new Error(`Refusing to run: SUPABASE_URL is not dev. Got: ${url}`);
  }
  const sb = createClient(url, process.env.SUPABASE_SERVICE_KEY!);

  const before = Date.now();
  const familyId = await createFamily(`Trial Test ${new Date().toISOString().slice(11, 19)}`);
  const after = Date.now();

  const { data } = await sb.from('families').select('paid_until').eq('id', familyId).single();
  const paidUntilMs = new Date(data!.paid_until).getTime();

  const expectedMin = before + 3 * 86400_000 - 1000; // 1s tolerance for round-trip
  const expectedMax = after + 3 * 86400_000 + 1000;
  console.log(`familyId: ${familyId}`);
  console.log(`paid_until: ${data!.paid_until}`);
  console.log(`expected: ${new Date(before + 3 * 86400_000).toISOString()} ± 1s`);

  if (paidUntilMs < expectedMin || paidUntilMs > expectedMax) {
    throw new Error(`paid_until out of range: got ${paidUntilMs}, expected ${expectedMin}..${expectedMax}`);
  }

  // Cleanup test row
  await sb.from('categories').delete().eq('family_id', familyId);
  await sb.from('families').delete().eq('id', familyId);
  console.log('\n✓ createFamily sets paid_until = now + 3 days. Test row cleaned up.');
}
main().catch((e) => { console.error(e); process.exit(1); });
