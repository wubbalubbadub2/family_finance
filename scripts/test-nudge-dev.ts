// Test the day1-nudge cron endpoint on dev.
//   1. dry_run=true   — confirm audience query runs without error
//   2. force_send_chat_id=173826717 — send the locked nudge text to Shynggys's
//      Telegram DM (chat_id = his telegram_id for private chats).
//
// READ + ONE SEND. Force-send does NOT touch DB state (no last_nudge_sent_at
// update). It's purely a Telegram delivery test.

const BASE = 'https://family-finance-git-dev-shynggys-projects-1cd759b1.vercel.app';

async function call(path: string, label: string) {
  const url = `${BASE}${path}`;
  console.log(`\n→ ${label}`);
  console.log(`  ${url}`);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const body = await res.text();
  console.log(`  HTTP ${res.status}`);
  try {
    const json = JSON.parse(body);
    console.log(`  ${JSON.stringify(json, null, 2).split('\n').join('\n  ')}`);
  } catch {
    console.log(`  ${body.slice(0, 500)}`);
  }
}

async function main() {
  console.log(`Testing dev alias: ${BASE}`);
  await call('/api/cron/day1-nudge?dry_run=true', '1. Dry-run (no sends, audience count only)');
  await call('/api/cron/day1-nudge?force_send_chat_id=173826717', '2. Force-send to Shynggys (173826717)');
}

main().catch(e => { console.error(e); process.exit(1); });

export {};
