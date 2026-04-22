import { NextRequest, NextResponse } from 'next/server';
import { getMonthSummary } from '@/lib/db/queries';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const year = parseInt(searchParams.get('year') ?? '');
  const month = parseInt(searchParams.get('month') ?? '');

  if (!year || !month) {
    return NextResponse.json({ error: 'year and month required' }, { status: 400 });
  }

  const summary = await getMonthSummary(year, month, DEFAULT_FAMILY_ID);
  return NextResponse.json(summary);
}
