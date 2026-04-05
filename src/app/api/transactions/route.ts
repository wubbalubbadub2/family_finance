import { NextRequest, NextResponse } from 'next/server';
import {
  getMonthTransactions,
  softDeleteTransaction,
} from '@/lib/db/queries';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const year = parseInt(searchParams.get('year') ?? '');
  const month = parseInt(searchParams.get('month') ?? '');

  if (!year || !month) {
    return NextResponse.json({ error: 'year and month required' }, { status: 400 });
  }

  const transactions = await getMonthTransactions(year, month);
  // Filter out soft-deleted and internal transfers for the dashboard
  const visible = transactions.filter(t => !t.deleted_at && t.type !== 'internal');

  return NextResponse.json(visible);
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    await softDeleteTransaction(id);
    console.log(`[DELETE] transaction ${id} soft-deleted`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[DELETE] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
