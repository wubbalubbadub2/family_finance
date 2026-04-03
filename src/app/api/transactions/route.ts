import { NextRequest, NextResponse } from 'next/server';
import {
  getMonthTransactions,
  getTransactionsByDateRange,
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
  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  await softDeleteTransaction(id);
  return NextResponse.json({ ok: true });
}
