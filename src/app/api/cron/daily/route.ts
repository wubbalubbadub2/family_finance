import { NextRequest, NextResponse } from 'next/server';
import { getActiveRecurring, insertTransaction, getMonthTransactions } from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, formatTenge } from '@/lib/utils';

// Verify cron secret to prevent unauthorized calls
function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = todayAlmaty();
  const dayOfMonth = parseInt(today.split('-')[2], 10);
  const { year, month } = currentMonthAlmaty();

  // 1. Process recurring transactions for today
  const recurring = await getActiveRecurring();
  const todayRecurring = recurring.filter(r => r.day_of_month === dayOfMonth);

  const created: string[] = [];
  for (const rt of todayRecurring) {
    // Check if already created today (avoid duplicates on retries)
    const monthTxns = await getMonthTransactions(year, month);
    const alreadyExists = monthTxns.some(
      t => t.source === 'recurring' &&
        t.category_id === rt.category_id &&
        t.amount === rt.amount &&
        t.transaction_date === today
    );

    if (!alreadyExists) {
      await insertTransaction({
        user_id: rt.created_by,
        category_id: rt.category_id,
        type: rt.type as 'expense' | 'income',
        amount: rt.amount,
        comment: rt.comment,
        source: 'recurring',
        transaction_date: today,
      });
      created.push(`${rt.comment}: ${formatTenge(rt.amount)}`);
    }
  }

  // 2. TODO: Send evening reminder at 21:00 (needs separate cron or time check)
  // 3. TODO: Send budget threshold alerts

  return NextResponse.json({
    ok: true,
    date: today,
    recurring_created: created,
  });
}
