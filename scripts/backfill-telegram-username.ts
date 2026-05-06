// One-time backfill: for every user with telegram_username = NULL, ask
// Telegram's getChat API for their profile. If they have a @handle, store it.
//
// Why this is needed: migration 016 added the column AFTER ~130 users had
// already registered. The runtime fix in getOrCreateUserInFamily only
// captures handles when a user next messages the bot — slow rollout. This
// script does it all at once.
//
// Run from the project root:
//   npx tsx --env-file .env.production.local scripts/backfill-telegram-username.ts
// Or against dev:
//   npx tsx --env-file .env.dev.local scripts/backfill-telegram-username.ts
//
// Idempotent: only touches rows where telegram_username IS NULL. Safe to re-run.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BOT_TOKEN) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

async function getChat(chatId: number): Promise<TelegramChat | null> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${chatId}`;
  try {
    const res = await fetch(url);
    const json = await res.json() as { ok: boolean; result?: TelegramChat; description?: string };
    if (!json.ok) {
      console.warn(`  ✗ ${chatId}: ${json.description ?? 'unknown error'}`);
      return null;
    }
    return json.result ?? null;
  } catch (e) {
    console.warn(`  ✗ ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function main() {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, telegram_id, name, telegram_username')
    .is('telegram_username', null);

  if (error) {
    console.error('Failed to query users:', error.message);
    process.exit(1);
  }
  if (!users || users.length === 0) {
    console.log('No users with NULL telegram_username. Nothing to backfill.');
    return;
  }

  console.log(`Backfilling @username for ${users.length} users...\n`);

  let captured = 0;
  let noHandle = 0;
  let failed = 0;

  for (const u of users) {
    const chat = await getChat(u.telegram_id);
    if (!chat) {
      failed++;
    } else if (chat.username) {
      const { error: updErr } = await supabase
        .from('users')
        .update({ telegram_username: chat.username })
        .eq('id', u.id);
      if (updErr) {
        console.warn(`  ✗ ${u.telegram_id} (${u.name}): update failed: ${updErr.message}`);
        failed++;
      } else {
        console.log(`  ✓ ${u.telegram_id} (${u.name}): @${chat.username}`);
        captured++;
      }
    } else {
      // User exists on Telegram but has no @handle set
      noHandle++;
    }
    // Polite throttle — Telegram allows ~30/sec but burst limits exist.
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('\n--- Summary ---');
  console.log(`Captured @handle:  ${captured}`);
  console.log(`No @handle set:    ${noHandle}`);
  console.log(`Failed (blocked / unknown / API error):  ${failed}`);
  console.log(`Total processed:   ${users.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
