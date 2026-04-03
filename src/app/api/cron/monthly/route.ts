import { NextRequest, NextResponse } from 'next/server';
import { getMonthlyPlans } from '@/lib/db/queries';
import { currentMonthAlmaty, monthNameRu } from '@/lib/utils';

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { year, month } = currentMonthAlmaty();

  // Check if a plan exists for the current month
  const plans = await getMonthlyPlans(year, month);

  if (plans.length === 0) {
    // TODO: Send Telegram message to both users:
    // "Начался {monthName}! Установите план на месяц с /setplan"
    const message = `Начался ${monthNameRu(month)} ${year}! Установите план с /setplan`;

    // This would use the Telegram Bot API to send a message
    // For now, just log it
    console.log('Monthly reminder:', message);

    return NextResponse.json({ ok: true, reminder_sent: true, message });
  }

  return NextResponse.json({ ok: true, plan_exists: true });
}
