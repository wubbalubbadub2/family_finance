import { NextRequest, NextResponse } from 'next/server';
import { getActiveRecurring, insertTransaction, getMonthTransactions, getMonthSummary } from '@/lib/db/queries';
import { todayAlmaty, currentMonthAlmaty, formatTenge } from '@/lib/utils';
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
  const today = todayAlmaty();
  const dayOfMonth = parseInt(today.split('-')[2], 10);
  const { year, month } = currentMonthAlmaty();

  // 1. Process recurring transactions
  const recurring = await getActiveRecurring();
  const todayRecurring = recurring.filter(r => r.day_of_month === dayOfMonth);

  const created: string[] = [];
  for (const rt of todayRecurring) {
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

  // 2. Send recurring transaction summary
  if (created.length > 0 && chatId) {
    await sendTelegramMessage(
      chatId,
      `🔄 *Автоматические записи*\n\n${created.join('\n')}`
    );
  }

  // 3. Check budget thresholds and send alerts
  if (chatId) {
    const summary = await getMonthSummary(year, month);
    const alerts: string[] = [];
    for (const cat of summary.categories) {
      if (cat.planned > 0) {
        if (cat.percentage >= 100) {
          alerts.push(`🔴 ${cat.category.emoji} ${cat.category.name}: превышен на ${formatTenge(Math.abs(cat.remaining))}`);
        } else if (cat.percentage >= 80) {
          alerts.push(`⚠️ ${cat.category.emoji} ${cat.category.name}: ${cat.percentage}% (${formatTenge(cat.actual)} из ${formatTenge(cat.planned)})`);
        }
      }
    }
    if (alerts.length > 0) {
      await sendTelegramMessage(chatId, `📊 *Контроль бюджета*\n\n${alerts.join('\n')}`);
    }
  }

  return NextResponse.json({ ok: true, date: today, recurring_created: created });
}
