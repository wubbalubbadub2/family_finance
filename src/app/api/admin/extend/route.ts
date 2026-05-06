// Admin API: set a family's paid_until to an absolute ISO date.
// Auth via src/middleware.ts (HTTP Basic Auth on /api/admin/*).
//
// Why absolute date (not delta): double-click safety. Client computes the
// target from currently-displayed paid_until and sends absolute ISO; two
// identical POSTs produce the same final state instead of compounding +30s.

import { NextRequest, NextResponse } from 'next/server';
import { setPaidUntil } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { familyId?: unknown; paidUntil?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const familyId = typeof body.familyId === 'string' ? body.familyId : null;
  const paidUntilStr = typeof body.paidUntil === 'string' ? body.paidUntil : null;
  if (!familyId || !paidUntilStr) {
    return NextResponse.json({ error: 'familyId + paidUntil required' }, { status: 400 });
  }

  const paidUntil = new Date(paidUntilStr);
  if (isNaN(paidUntil.getTime())) {
    return NextResponse.json({ error: 'invalid paidUntil date' }, { status: 400 });
  }

  try {
    await setPaidUntil(familyId, paidUntil);
    return NextResponse.json({ ok: true, familyId, paidUntil: paidUntil.toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
