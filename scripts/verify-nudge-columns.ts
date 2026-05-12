// Verify migration 018 columns exist on families.
// Read-only — pulls 1 row to confirm columns + defaults.

import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  console.log(`DB: ${process.env.SUPABASE_URL}`);

  const { data, error } = await sb
    .from('families')
    .select('id, name, reminders_disabled, last_nudge_sent_at')
    .limit(3);

  if (error) {
    console.error('✗ Failed:', error.message);
    console.error('  Did you paste migration 018 into Supabase SQL editor?');
    process.exit(1);
  }

  console.log(`✓ Both columns exist. Sample rows:`);
  for (const r of data ?? []) {
    console.log(`  ${r.name?.slice(0,20)}  reminders_disabled=${r.reminders_disabled}  last_nudge_sent_at=${r.last_nudge_sent_at ?? '-'}`);
  }

  // Confirm default rolled out
  const { count: total } = await sb.from('families').select('id', { count: 'exact', head: true });
  const { count: enabled } = await sb.from('families').select('id', { count: 'exact', head: true }).eq('reminders_disabled', false);
  console.log();
  console.log(`Total families on dev: ${total}`);
  console.log(`With reminders enabled (default): ${enabled}`);
  console.log(`Mismatch: ${total === enabled ? 'no — default backfilled cleanly' : 'YES — investigate'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
