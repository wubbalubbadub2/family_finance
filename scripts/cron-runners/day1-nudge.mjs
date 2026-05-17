// Day-1 nudge runner — executes inside GitHub Actions, not Vercel.
//
// Why this exists: Vercel Hobby caps function execution at 60s, and our
// audience (~376 families) at sequential ~300ms/send exceeds that. Moving
// the send loop to the GH Actions runner removes the timeout ceiling
// entirely (5min job timeout via the workflow file).
//
// Architecture:
//   1. GET <PROD_URL>/api/cron/day1-nudge/candidates → list of {family_id, family_name, chat_id}
//   2. For each, in parallel (CONCURRENCY=10):
//        POST https://api.telegram.org/bot<TOKEN>/sendMessage
//        On success: POST <PROD_URL>/api/cron/day1-nudge/mark {status:'sent'}
//        On 403 blocked-by-user: POST <mark> {status:'blocked'}
//        On other error: log + count, no mark
//   3. Print summary + exit non-zero if any errors (but blocked counts as OK).
//
// Telegram rate limit: 30 msgs/sec global. CONCURRENCY=10 at ~300ms/req
// → ~30 req/sec ceiling, but with network variance we average lower. Safe.
//
// Required env (from workflow):
//   PROD_URL              — https://family-finance-taupe.vercel.app (or dev URL)
//   CRON_SECRET           — for candidates + mark endpoints
//   TELEGRAM_BOT_TOKEN    — bot token for sendMessage
//
// Idempotency: markFamilyNudgeSent updates last_nudge_sent_at = now(). If the
// runner crashes mid-loop, families already marked-sent are skipped tomorrow.
// Unmarked ones get re-attempted tomorrow (same family won't get TWO nudges
// in one day because the within-day idempotency gate fires on last_nudge_sent_at).

const PROD_URL = process.env.PROD_URL;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '10');
const DRY_RUN = process.env.DRY_RUN === 'true';

// Locked text — must match NUDGE_TEXT in src/lib/cron/day1-nudge.ts.
const NUDGE_TEXT =
  'Спишь? Напиши мне пожалуйста, я сильно жду от тебя сообщение :)\n\n' +
  '<i>не хочешь напоминания - напиши /notifications off</i>';

function assertEnv() {
  const missing = [];
  if (!PROD_URL) missing.push('PROD_URL');
  if (!CRON_SECRET) missing.push('CRON_SECRET');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (missing.length) {
    console.error(`::error::Missing required env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function fetchCandidates() {
  const res = await fetch(`${PROD_URL}/api/cron/day1-nudge/candidates`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`candidates fetch ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.candidates)) {
    throw new Error(`unexpected candidates payload: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.candidates;
}

async function sendTelegram(chatId) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: NUDGE_TEXT, parse_mode: 'HTML' }),
  });
  if (res.ok) return { ok: true, blocked: false, errorMessage: null };
  const body = await res.text().catch(() => '');
  // Same regex as the legacy in-route handler — 403 + these substrings = permanent block.
  const blocked =
    res.status === 403 && /blocked by the user|bot was blocked|kicked|chat not found/i.test(body);
  return { ok: false, blocked, errorMessage: `${res.status}: ${body.slice(0, 200)}` };
}

async function markBack(familyId, status, opts = {}) {
  const res = await fetch(`${PROD_URL}/api/cron/day1-nudge/mark`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      family_id: familyId,
      status,
      latency_ms: opts.latencyMs,
      family_name: opts.familyName,
      error_message: opts.errorMessage,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`::warning::mark ${status} failed for ${familyId}: ${res.status} ${body.slice(0, 200)}`);
  }
}

async function processOne(fam) {
  const tStart = Date.now();
  const outcome = await sendTelegram(fam.chat_id);
  const latency = Date.now() - tStart;

  if (outcome.ok) {
    if (!DRY_RUN) await markBack(fam.family_id, 'sent', { latencyMs: latency, familyName: fam.family_name });
    return { kind: 'sent', familyId: fam.family_id, familyName: fam.family_name, latency };
  }
  if (outcome.blocked) {
    if (!DRY_RUN) await markBack(fam.family_id, 'blocked', {
      familyName: fam.family_name,
      errorMessage: outcome.errorMessage,
    });
    return { kind: 'blocked', familyId: fam.family_id, familyName: fam.family_name, latency };
  }
  return {
    kind: 'error',
    familyId: fam.family_id,
    familyName: fam.family_name,
    latency,
    errorMessage: outcome.errorMessage,
  };
}

async function runInBatches(items, concurrency, handler) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await handler(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  assertEnv();
  console.log(`[day1-nudge:runner] PROD_URL=${PROD_URL} CONCURRENCY=${CONCURRENCY} DRY_RUN=${DRY_RUN}`);

  const tFetch = Date.now();
  const candidates = await fetchCandidates();
  console.log(`[day1-nudge:runner] candidates=${candidates.length} (fetch ${Date.now() - tFetch}ms)`);

  if (candidates.length === 0) {
    console.log('[day1-nudge:runner] no candidates today — nothing to do');
    return;
  }

  const tSend = Date.now();
  const results = await runInBatches(candidates, CONCURRENCY, processOne);
  const elapsed = Date.now() - tSend;

  const sent = results.filter(r => r.kind === 'sent');
  const blocked = results.filter(r => r.kind === 'blocked');
  const errors = results.filter(r => r.kind === 'error');

  console.log('');
  console.log('─── Summary ───');
  console.log(`Audience: ${candidates.length}`);
  console.log(`Sent:     ${sent.length}`);
  console.log(`Blocked:  ${blocked.length}`);
  console.log(`Errors:   ${errors.length}`);
  console.log(`Elapsed:  ${elapsed}ms (${(elapsed / candidates.length).toFixed(0)}ms/family avg)`);
  console.log(`Mode:     ${DRY_RUN ? 'DRY-RUN (no mark-back, no DB write)' : 'LIVE'}`);

  if (errors.length > 0) {
    console.log('');
    console.log('─── Errors ───');
    for (const e of errors) {
      console.log(`  ${e.familyId} (${e.familyName}): ${e.errorMessage}`);
    }
    // Non-fatal: blocked is success-equivalent, but actual send errors
    // should turn the workflow red so we notice.
    process.exit(1);
  }
}

main().catch(err => {
  console.error('::error::day1-nudge runner crashed:', err?.stack ?? err);
  process.exit(1);
});
