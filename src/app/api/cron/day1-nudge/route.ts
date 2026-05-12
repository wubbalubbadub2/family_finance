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

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === 'true';
  const restrictRaw = url.searchParams.get('restrict_family_id');
  // Loose UUID shape check — block stray garbage but not the strict spec.
  const restrictFamilyId =
    restrictRaw && /^[0-9a-f-]{32,40}$/i.test(restrictRaw) ? restrictRaw : null;

  try {
    const result = await sendDay1Nudges({ dryRun, restrictFamilyId });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[cron:day1-nudge] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
