import { NextRequest, NextResponse } from 'next/server';
import { getMonthlyPlans } from '@/lib/db/queries';
import { currentMonthAlmaty, monthNameRu } from '@/lib/utils';
import { sendTelegramMessage } from '@/lib/bot/send-message';

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const chatId = process.env.FAMILY_CHAT_ID;
  if (!chatId) return NextResponse.json({ ok: true, skipped: 'no FAMILY_CHAT_ID' });

  const { year, month } = currentMonthAlmaty();
  const plans = await getMonthlyPlans(year, month);

  if (plans.length === 0) {
    const appUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}/plan`
      : 'the web dashboard';

    await sendTelegramMessage(
      chatId,
      `🗓 Начался *${monthNameRu(month)} ${year}*!\n\nУстановите бюджет на месяц через /setplan или на сайте:\n${appUrl}`
    );

    return NextResponse.json({ ok: true, reminder_sent: true });
  }

  return NextResponse.json({ ok: true, plan_exists: true });
}
