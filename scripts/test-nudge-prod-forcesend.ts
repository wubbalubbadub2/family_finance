// One-shot prod force-send test of the day1-nudge cron route.
//
// Sends the locked nudge text to chat_id=173826717 (Shynggys's Telegram DM)
// via the PROD bot. This bypasses the audience filter entirely — pure
// delivery verification only.
//
// Side effects:
//   - 1 Telegram DM from prod bot to me
//   - NO last_nudge_sent_at update (force_send branch doesn't touch state)
//   - NO bot_actions_log row (force_send branch doesn't log)
//
// Run:
//   npx tsx --env-file=.env.production.local scripts/test-nudge-prod-forcesend.ts

const PROD_URL = 'https://family-finance-taupe.vercel.app';

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) { console.error('CRON_SECRET missing'); process.exit(1); }

  console.log(`Testing prod alias: ${PROD_URL}`);
  console.log();

  // 1. Dry-run first to confirm the route is alive and audience query works.
  const dryRes = await fetch(`${PROD_URL}/api/cron/day1-nudge?dry_run=true`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const dry = await dryRes.json();
  console.log(`1. Dry-run audience query (HTTP ${dryRes.status}):`);
  console.log(`   audience_count=${dry.audience_count}`);
  console.log(`   ok=${dry.ok}`);

  // 2. Force-send to Shynggys's DM.
  const sendRes = await fetch(`${PROD_URL}/api/cron/day1-nudge?force_send_chat_id=173826717`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const send = await sendRes.json();
  console.log();
  console.log(`2. Force-send to 173826717 (HTTP ${sendRes.status}):`);
  console.log(`   ${JSON.stringify(send, null, 2).split('\n').join('\n   ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });

export {};
