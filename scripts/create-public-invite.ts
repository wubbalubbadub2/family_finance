// Insert (or upsert) the perpetual public invite code.
//
// Per migration 015, uses_remaining=NULL means unlimited / multi-use. Each
// redemption creates a fresh family for the redeemer. expires_at=NULL means
// never expires.
//
// Idempotent: re-running this script on an existing 'public' code is a no-op
// (UPSERT semantics via the PRIMARY KEY on `code`).
//
// Usage (dev):
//   npx tsx --env-file .env.dev.local scripts/create-public-invite.ts
// Usage (prod):
//   npx tsx --env-file .env.production.local scripts/create-public-invite.ts
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  if (!url) throw new Error('SUPABASE_URL not set');

  const sb = createClient(url, key);

  const code = 'public';

  const { data: existing } = await sb
    .from('family_invites')
    .select('code, uses_remaining, expires_at, created_at')
    .eq('code', code)
    .single();

  if (existing) {
    console.log(`\nPublic invite already exists:`);
    console.log(`  code:           ${existing.code}`);
    console.log(`  uses_remaining: ${existing.uses_remaining ?? 'NULL (unlimited)'}`);
    console.log(`  expires_at:     ${existing.expires_at ?? 'NULL (never)'}`);
    console.log(`  created_at:     ${existing.created_at}\n`);
    return;
  }

  // The 'public' code is special: it's not tied to any specific family.
  // family_id is NOT NULL in the schema (per migration 009), so we need to
  // point it somewhere. We attach it to the first family in the table —
  // it's a placeholder; the multi-use redemption code IGNORES family_id and
  // creates a fresh family instead.
  const { data: anyFamily } = await sb
    .from('families').select('id').limit(1).single();
  if (!anyFamily) {
    throw new Error('No families exist yet — create one before the public invite.');
  }

  const { error } = await sb.from('family_invites').insert({
    code,
    family_id: anyFamily.id, // placeholder — ignored by the multi-use redemption code
    uses_remaining: null,    // NULL = unlimited (multi-use)
    expires_at: null,        // NULL = never expires
  });
  if (error) throw error;

  console.log(`\nPublic invite created.`);
  console.log(`Code: ${code}`);
  console.log(`Link pattern: https://t.me/<bot_username>?start=invite_${code}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
