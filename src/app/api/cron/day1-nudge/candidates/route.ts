// Day-1 nudge — candidates endpoint (read-only).
//
// Why this exists (2026-05-17): the original /api/cron/day1-nudge route did
// the full fetch-and-send loop inside one Vercel serverless function. With
// ~376 candidates at ~300ms/send sequential, that's ~113s — over Hobby's 60s
// timeout. Backlog spike when the cron was broken made this worse.
//
// New architecture splits responsibility:
//   - Vercel: this endpoint returns candidate list (fast, well under 60s).
//   - GitHub Actions runner: does the actual sends in parallel, no timeout.
//   - Vercel POST /api/cron/day1-nudge/mark: records each result back.
//
// Auth: same Bearer ${CRON_SECRET} as other cron routes.

import { NextRequest, NextResponse } from 'next/server';
import { getDay1NudgeCandidates } from '@/lib/db/queries';

function verifyCron(req: NextRequest): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const candidates = await getDay1NudgeCandidates();
    return NextResponse.json({ ok: true, count: candidates.length, candidates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[cron:day1-nudge:candidates] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
