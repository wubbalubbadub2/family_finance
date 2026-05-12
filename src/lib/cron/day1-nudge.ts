// Day-1 re-engagement nudge — pure function. The cron route wraps this with
// HTTP auth + JSON output; tests can call this directly.
//
// Behavior:
//   - Fetch candidates via getDay1NudgeCandidates (returns ~60-80 families/day).
//   - For each: sendMessage with the locked nudge text. Sequentially with a
//     small inter-send delay to stay under Telegram's bot rate limit.
//   - On `Forbidden: bot was blocked by the user` → set reminders_disabled=true
//     so we never bother them again. Counts as "blocked", not "sent".
//   - On any other send failure → log to error_log, count as "errors".
//   - On success → markFamilyNudgeSent + log to bot_actions_log.
//
// Options:
//   dryRun           : log audience size but skip all sendMessage calls.
//   restrictFamilyId : if set, filter audience to just that family. Used for
//                      the first real send (only fires to a chosen test family).
//
// The text is LOCKED (per design doc + user approval 2026-05-12). Don't tweak
// without re-approval.

import {
  getDay1NudgeCandidates,
  markFamilyNudgeSent,
  setFamilyRemindersDisabled,
  type Day1NudgeCandidate,
} from '@/lib/db/queries';
import { captureError, logBotAction } from '@/lib/observability';

const NUDGE_TEXT = 'Спишь? Напиши мне пожалуйста, я сильно жду от тебя сообщение :)';
const INTER_SEND_DELAY_MS = 50;

export interface SendDay1NudgesResult {
  audience_count: number;
  sent: number;
  blocked: number;
  errors: number;
  dry_run: boolean;
  restrict_family_id: string | null;
  sent_families: Array<{ family_id: string; family_name: string; latency_ms: number }>;
  blocked_families: Array<{ family_id: string; family_name: string }>;
  error_families: Array<{ family_id: string; family_name: string; message: string }>;
}

export interface SendDay1NudgesOptions {
  dryRun?: boolean;
  restrictFamilyId?: string | null;
}

interface SendOutcome {
  ok: boolean;
  blocked: boolean;
  errorMessage: string | null;
}

async function sendNudgeWithErrorDetail(chatId: number): Promise<SendOutcome> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, blocked: false, errorMessage: 'TELEGRAM_BOT_TOKEN missing' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: NUDGE_TEXT }),
    });
    if (res.ok) return { ok: true, blocked: false, errorMessage: null };

    // Telegram returns 403 with description "Forbidden: bot was blocked by
    // the user" when the user has blocked us. We treat this as a permanent
    // signal — auto opt-out, never nudge again.
    const body = (await res.text().catch(() => '')) ?? '';
    const blocked = res.status === 403 && /blocked by the user|bot was blocked|kicked|chat not found/i.test(body);
    return { ok: false, blocked, errorMessage: `${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, blocked: false, errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendDay1Nudges(opts: SendDay1NudgesOptions = {}): Promise<SendDay1NudgesResult> {
  const dryRun = opts.dryRun === true;
  const restrictFamilyId = opts.restrictFamilyId ?? null;

  const all = await getDay1NudgeCandidates();
  const audience: Day1NudgeCandidate[] = restrictFamilyId
    ? all.filter(c => c.family_id === restrictFamilyId)
    : all;

  const result: SendDay1NudgesResult = {
    audience_count: audience.length,
    sent: 0,
    blocked: 0,
    errors: 0,
    dry_run: dryRun,
    restrict_family_id: restrictFamilyId,
    sent_families: [],
    blocked_families: [],
    error_families: [],
  };

  if (dryRun) {
    console.log(`[day1-nudge] dry-run: audience=${audience.length}, restrict=${restrictFamilyId ?? '-'}`);
    return result;
  }

  for (const fam of audience) {
    const tStart = Date.now();
    const outcome = await sendNudgeWithErrorDetail(fam.chat_id);
    const latency = Date.now() - tStart;

    if (outcome.ok) {
      result.sent++;
      result.sent_families.push({ family_id: fam.family_id, family_name: fam.family_name, latency_ms: latency });
      // Best-effort writes — never let observability/state failure crash the loop.
      void markFamilyNudgeSent(fam.family_id).catch(e => {
        void captureError(e, { source: 'cron:day1_nudge:markSent', familyId: fam.family_id });
      });
      void logBotAction({
        source: 'cron:day1_nudge',
        familyId: fam.family_id,
        replyLength: NUDGE_TEXT.length,
        latencyMs: latency,
        meta: { delivered: true },
      });
    } else if (outcome.blocked) {
      result.blocked++;
      result.blocked_families.push({ family_id: fam.family_id, family_name: fam.family_name });
      void setFamilyRemindersDisabled(fam.family_id, true).catch(e => {
        void captureError(e, { source: 'cron:day1_nudge:autoOptOut', familyId: fam.family_id });
      });
      void logBotAction({
        source: 'cron:day1_nudge',
        familyId: fam.family_id,
        latencyMs: latency,
        meta: { delivered: false, blocked: true, error: outcome.errorMessage },
      });
    } else {
      result.errors++;
      result.error_families.push({
        family_id: fam.family_id,
        family_name: fam.family_name,
        message: outcome.errorMessage ?? 'unknown',
      });
      void captureError(new Error(outcome.errorMessage ?? 'unknown'), {
        source: 'cron:day1_nudge:send',
        familyId: fam.family_id,
        context: { chat_id: fam.chat_id },
      });
      void logBotAction({
        source: 'cron:day1_nudge',
        familyId: fam.family_id,
        latencyMs: latency,
        meta: { delivered: false, blocked: false, error: outcome.errorMessage },
      });
    }

    // Stay well under Telegram's 30 msg/sec per-bot limit.
    if (INTER_SEND_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, INTER_SEND_DELAY_MS));
    }
  }

  return result;
}
