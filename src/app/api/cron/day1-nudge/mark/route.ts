// Day-1 nudge — per-family result mark endpoint.
//
// Called by the GitHub Actions runner once per family after each Telegram
// send attempt. Two statuses:
//   - 'sent'    → markFamilyNudgeSent (idempotency gate for tomorrow's cron)
//   - 'blocked' → setFamilyRemindersDisabled(true) (user blocked the bot;
//                 same behavior as the legacy in-route 403 handler).
//
// Each call is independent; runner can re-POST safely on retry (markFamilyNudgeSent
// is idempotent — sets last_nudge_sent_at = now(); setFamilyRemindersDisabled
// idempotent for same value).
//
// Auth: same Bearer ${CRON_SECRET} as other cron routes.
//
// Body shape:
//   { family_id: uuid, status: 'sent' | 'blocked', latency_ms?: number,
//     family_name?: string, error_message?: string }
// `family_name` and `error_message` are optional, only used for telemetry.

import { NextRequest, NextResponse } from 'next/server';
import { markFamilyNudgeSent, setFamilyRemindersDisabled } from '@/lib/db/queries';
import { logBotAction, captureError } from '@/lib/observability';

function verifyCron(req: NextRequest): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
}

interface MarkBody {
  family_id?: unknown;
  status?: unknown;
  latency_ms?: unknown;
  family_name?: unknown;
  error_message?: unknown;
}

export async function POST(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: MarkBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const familyId = typeof body.family_id === 'string' ? body.family_id : null;
  const status = body.status === 'sent' || body.status === 'blocked' ? body.status : null;
  if (!familyId || !/^[0-9a-f-]{32,40}$/i.test(familyId)) {
    return NextResponse.json({ ok: false, error: 'invalid_family_id' }, { status: 400 });
  }
  if (!status) {
    return NextResponse.json({ ok: false, error: 'invalid_status' }, { status: 400 });
  }

  const latencyMs = typeof body.latency_ms === 'number' ? body.latency_ms : undefined;
  const familyName = typeof body.family_name === 'string' ? body.family_name : undefined;
  const errorMessage = typeof body.error_message === 'string' ? body.error_message : undefined;

  try {
    if (status === 'sent') {
      await markFamilyNudgeSent(familyId);
      void logBotAction({
        source: 'cron:day1_nudge',
        familyId,
        latencyMs,
        meta: { outcome: 'sent', runner: 'gh_actions', family_name: familyName },
      });
    } else {
      await setFamilyRemindersDisabled(familyId, true);
      void logBotAction({
        source: 'cron:day1_nudge:blocked',
        familyId,
        latencyMs,
        meta: {
          outcome: 'blocked',
          runner: 'gh_actions',
          family_name: familyName,
          error_message: errorMessage,
        },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void captureError(e, { source: 'cron:day1_nudge:mark', familyId, context: { status } });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
