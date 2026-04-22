import { NextRequest, NextResponse } from 'next/server';
import { getMonthSummary, getTransactionsByDateRange } from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { sendTelegramMessage } from '@/lib/bot/send-message';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';

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

  const today = todayAlmaty();
  const { year, month } = currentMonthAlmaty();

  // Get today's transactions
  const todayTxns = (await getTransactionsByDateRange(today, today, DEFAULT_FAMILY_ID))
    .filter(t => t.type === 'expense' && !t.deleted_at);

  const todayTotal = todayTxns.reduce((s, t) => s + t.amount, 0);

  // Get month summary for context
  const summary = await getMonthSummary(year, month, DEFAULT_FAMILY_ID);
  const { total_actual, total_planned, safe_daily_remaining } = summary;

  let msg = '';
  if (todayTxns.length === 0) {
    msg = '📝 Сегодня расходов не записано. Всё внесли?';
  } else {
    msg = `📝 Сегодня: ${formatTenge(todayTotal)} (${todayTxns.length} записей)`;
    if (total_planned > 0) {
      msg += `\n💰 За месяц: ${formatTenge(total_actual)} из ${formatTenge(total_planned)}`;
      if (safe_daily_remaining > 0) {
        msg += `\n✨ Можно тратить ${formatTenge(safe_daily_remaining)}/день`;
      }
    }
  }

  await sendTelegramMessage(chatId, msg);

  return NextResponse.json({ ok: true, message: msg });
}
