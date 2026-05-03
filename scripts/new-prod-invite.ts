// Quick script: create a fresh family in PROD + seed categories + return invite link.
// Usage: NAME=dali PREFIX=dal npx tsx --env-file .env.production.local scripts/new-prod-invite.ts
import { createClient } from '@supabase/supabase-js';

async function main() {
  const NAME = process.env.NAME;
  const PREFIX = process.env.PREFIX;
  if (!NAME || !PREFIX) throw new Error('Set NAME and PREFIX env vars');

  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  if (!url.includes('nzukbmohxdexzhryshap')) {
    throw new Error(`Refusing to run: SUPABASE_URL is not prod. Got: ${url}`);
  }

  const sb = createClient(url, key);

  const familyName = `${NAME}'s family`;
  // 3-day trial — set explicitly per migration 013 (no DB default by design).
  const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: family, error: famErr } = await sb
    .from('families')
    .insert({ name: familyName, paid_until: trialEnd })
    .select('id')
    .single();
  if (famErr) throw famErr;
  const familyId = family.id;

  const { error: seedErr } = await sb.rpc('seed_default_categories_for_family', { p_family_id: familyId });
  if (seedErr) throw seedErr;

  const code = `${PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { error: invErr } = await sb
    .from('family_invites')
    .insert({ code, family_id: familyId, expires_at: expiresAt, uses_remaining: 1 });
  if (invErr) throw invErr;

  console.log(`\nFamily: ${familyName}`);
  console.log(`Family ID: ${familyId}`);
  console.log(`Invite link: https://t.me/islam_family_finance_bot?start=invite_${code}`);
  console.log(`Expires: ${expiresAt} (14 days)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
