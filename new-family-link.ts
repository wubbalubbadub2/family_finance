// Create an additional fresh family + invite link in the DEV DB. Useful for
// testing the two-families-at-once case: share the link with a second
// Telegram account (or your wife / a friend) and verify their writes stay
// scoped to their family — no cross-leak with Shynggys's data.
//
// Usage: node --import tsx --env-file .env.dev.local new-family-link.ts [name]

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function main() {
  const familyName = process.argv[2] || `Test Family ${new Date().toISOString().slice(11, 19)}`;

  const { data: fam, error: famErr } = await sb
    .from('families')
    .insert({ name: familyName })
    .select('id')
    .single();
  if (famErr || !fam) {
    console.error('Family create failed:', famErr?.message);
    process.exit(1);
  }
  console.log(`Created family ${fam.id} (${familyName})`);

  // Universal default categories from migration 011
  const { error: seedErr } = await sb.rpc('seed_default_categories_for_family', {
    p_family_id: fam.id,
  });
  if (seedErr) console.warn('Seed RPC failed (non-fatal):', seedErr.message);
  else console.log('Seeded universal default categories');

  // Single-use invite valid for 24h
  const code = 'fresh' + Math.random().toString(36).slice(2, 8);
  const { error: invErr } = await sb.from('family_invites').insert({
    family_id: fam.id,
    code,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (invErr) {
    console.error('Invite create failed:', invErr.message);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════');
  console.log('NEW FAMILY READY');
  console.log('═══════════════════════════════════════');
  console.log(`Name:         ${familyName}`);
  console.log(`Family ID:    ${fam.id}`);
  console.log(`Invite link:  https://t.me/islam_family_finance_dev_bot?start=invite_${code}`);
  console.log('');
  console.log('Share the link with a second Telegram account — they will');
  console.log('be auto-onboarded as a separate family. Use it to verify:');
  console.log('  • their writes don\'t appear in your existing family');
  console.log('  • their categories are independent (8 universal defaults)');
  console.log('  • inviting them to YOUR group still routes to YOUR family');
  console.log('═══════════════════════════════════════');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
