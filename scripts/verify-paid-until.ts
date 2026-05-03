// Verify migration 013 backfill on dev. Lists every family with its paid_until.
// Refuses to run against prod by URL check.
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  if (!url.includes('rcpuvqjrtxyuvmnjandm')) {
    throw new Error(`Refusing to run: SUPABASE_URL is not dev. Got: ${url}`);
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from('families')
    .select('id, name, paid_until, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  console.log(`${data?.length ?? 0} families:`);
  for (const f of data ?? []) {
    console.log(`  ${f.id.slice(0, 8)}  ${f.paid_until?.slice(0, 10) ?? 'NULL'}  ${f.name}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
