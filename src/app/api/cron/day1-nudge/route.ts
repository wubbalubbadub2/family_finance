// Day-1 re-engagement nudge cron handler.
//
// Schedule (eventually in vercel.json): 0 16 * * *  = 16:00 UTC = 21:00 Almaty.
// NOT yet registered in vercel.json — the route exists but cron is opt-in.
// During the dev smoke + first prod soak we invoke it manually with a bearer
// token. Once we're confident in audience filtering + send behavior, we add
// the schedule.
//
// Auth: same Bearer ${CRON_SECRET} pattern as other cron routes.
//
// Query params (testing aids):
//   ?dry_run=true                   → skip all sendMessage calls, just count audience
//   ?restrict_family_id={uuid}      → narrow audience to one family for first real test
//
// Returns JSON with sent / blocked / errors counts + per-family detail.

import { NextRequest, NextResponse } from 'next/server';
import { sendDay1Nudges } from '@/lib/cron/day1-nudge';

const NUDGE_TEXT = 'Спишь? Напиши мне пожалуйста, я сильно жду от тебя сообщение :)';

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

/**
 * Debug-only: send the locked nudge text to a single chat_id, bypassing
 * the audience filter entirely. Used to verify the send-side pipeline
 * (Telegram delivery, message rendering) WITHOUT requiring the test user
 * to satisfy the "engaged but silent today" audience filter.
 *
 * Still gated by CRON_SECRET — never callable by an unauth user.
 * Does NOT write to last_nudge_sent_at (it's not a real nudge).
 * Does NOT log to bot_actions_log (would pollute analytics).
 */
async function forceSendOnce(chatId: number): Promise<{ delivered: boolean; status?: number; body?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { delivered: false, body: 'TELEGRAM_BOT_TOKEN missing' };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: NUDGE_TEXT }),
  });
  if (res.ok) return { delivered: true, status: res.status };
  const body = await res.text().catch(() => '');
  return { delivered: false, status: res.status, body: body.slice(0, 300) };
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === 'true';
  const restrictRaw = url.searchParams.get('restrict_family_id');
  const forceSendChatIdRaw = url.searchParams.get('force_send_chat_id');

  // Loose UUID shape check — block stray garbage but not the strict spec.
  const restrictFamilyId =
    restrictRaw && /^[0-9a-f-]{32,40}$/i.test(restrictRaw) ? restrictRaw : null;

  // Force-send debug branch: skip audience entirely, single send only.
  if (forceSendChatIdRaw) {
    const chatId = Number(forceSendChatIdRaw);
    if (!Number.isFinite(chatId) || chatId === 0) {
      return NextResponse.json({ ok: false, error: 'invalid force_send_chat_id' }, { status: 400 });
    }
    const result = await forceSendOnce(chatId);
    return NextResponse.json({ ok: result.delivered, force_send_chat_id: chatId, ...result });
  }

  try {
    const result = await sendDay1Nudges({ dryRun, restrictFamilyId });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[cron:day1-nudge] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
