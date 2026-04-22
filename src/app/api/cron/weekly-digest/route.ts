import { NextRequest, NextResponse } from 'next/server';
import {
  getAllFamilies,
  getUsersInFamily,
  getTransactionsByDateRange,
  getCategoriesForFamily,
  getActiveGoal,
} from '@/lib/db/queries';
import { formatTenge } from '@/lib/utils';
import { computeWeekBoundsAlmaty, renderGoalProgress } from '@/lib/goals';
import { sendTelegramMessage } from '@/lib/bot/send-message';

/**
 * Sunday weekly digest cron.
 *
 * Schedule: Sunday 20:00 Almaty = 15:00 UTC Sunday (see vercel.json).
 * Almaty is UTC+5; Sunday 15:00 UTC = Monday 20:00 Almaty... wait, that's wrong.
 *
 * Correction: Sunday 15:00 UTC = Sunday 20:00 Almaty ✓
 * (Almaty is UTC+5, so UTC 15:00 + 5h = local 20:00)
 *
 * For each family: sum transactions Mon 00:00 Almaty → Sun 23:59:59 Almaty,
 * break down per member + top categories + goal progress, post to primary_chat_id.
 */

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

interface PerMemberTotal {
  user_id: string;
  name: string;
  total: number;
}

interface PerCategoryTotal {
  category_id: number;
  emoji: string;
  name: string;
  total: number;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const families = await getAllFamilies();
  const results: Array<{ family_id: string; name: string; sent: boolean; reason?: string }> = [];

  // Compute week bounds ONCE — Almaty-local Monday→Sunday of the week that
  // JUST ended. When cron fires Sunday 20:00 Almaty, "this week" is the
  // Monday through right now.
  const bounds = computeWeekBoundsAlmaty(new Date());
  // Query uses transaction_date (DATE), not timestamps — so pass the date strings.
  // Week ENDS exclusive in bounds (Monday next), so end date = weekEnd - 1 day for BETWEEN.
  // computeWeekBoundsAlmaty returns weekEndDate as Monday of NEXT week. The last
  // date included in the digest is that minus 1 day, i.e. today's Sunday.
  const weekStartDate = bounds.weekStartDate;
  const weekEndDate = new Date(new Date(bounds.weekEndDate).getTime() - 86_400_000)
    .toISOString().slice(0, 10);

  for (const family of families) {
    if (!family.primary_chat_id) {
      results.push({ family_id: family.id, name: family.name, sent: false, reason: 'no primary_chat_id' });
      continue;
    }

    try {
      const [users, categories, txns, goal] = await Promise.all([
        getUsersInFamily(family.id),
        getCategoriesForFamily(family.id),
        getTransactionsByDateRange(weekStartDate, weekEndDate, family.id),
        getActiveGoal(family.id).catch(() => null),
      ]);

      const userMap = new Map(users.map(u => [u.id, u.name]));
      const catMap = new Map(categories.map(c => [c.id, c]));

      const expenses = txns.filter(t => t.type === 'expense' && !t.deleted_at);
      const income = txns.filter(t => t.type === 'income' && !t.deleted_at);

      if (expenses.length === 0 && income.length === 0) {
        results.push({ family_id: family.id, name: family.name, sent: false, reason: 'no activity' });
        continue;
      }

      // Per-member totals
      const memberTotals = new Map<string, number>();
      for (const t of expenses) {
        memberTotals.set(t.user_id, (memberTotals.get(t.user_id) ?? 0) + t.amount);
      }
      const perMember: PerMemberTotal[] = Array.from(memberTotals.entries())
        .map(([uid, total]) => ({
          user_id: uid,
          name: userMap.get(uid) ?? 'неизв.',
          total,
        }))
        .sort((a, b) => b.total - a.total);

      // Per-category totals (top 3)
      const catTotals = new Map<number, number>();
      for (const t of expenses) {
        if (t.category_id) {
          catTotals.set(t.category_id, (catTotals.get(t.category_id) ?? 0) + t.amount);
        }
      }
      const perCategory: PerCategoryTotal[] = Array.from(catTotals.entries())
        .map(([cid, total]) => {
          const cat = catMap.get(cid);
          return {
            category_id: cid,
            emoji: cat?.emoji ?? '❓',
            name: cat?.name ?? 'неизв.',
            total,
          };
        })
        .sort((a, b) => b.total - a.total)
        .slice(0, 3);

      const totalExp = expenses.reduce((s, t) => s + t.amount, 0);
      const totalInc = income.reduce((s, t) => s + t.amount, 0);

      // Build message
      let msg = `📅 Неделя ${weekStartDate} → ${weekEndDate}\n\n`;
      msg += `Всего потрачено: *${formatTenge(totalExp)}*\n`;
      if (totalInc > 0) msg += `Поступления: *${formatTenge(totalInc)}*\n`;

      if (perMember.length > 0) {
        msg += `\n*По членам семьи:*\n`;
        for (const m of perMember) {
          msg += `- ${m.name}: ${formatTenge(m.total)}\n`;
        }
      }

      if (perCategory.length > 0) {
        msg += `\n*Топ категорий:*\n`;
        for (const c of perCategory) {
          msg += `- ${c.emoji} ${c.name}: ${formatTenge(c.total)}\n`;
        }
      }

      const goalLine = renderGoalProgress(goal);
      if (goalLine) msg += `\n${goalLine}`;

      await sendTelegramMessage(String(family.primary_chat_id), msg);
      results.push({ family_id: family.id, name: family.name, sent: true });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`[weekly-digest] family ${family.id} failed:`, err);
      results.push({ family_id: family.id, name: family.name, sent: false, reason: `error: ${err}` });
    }
  }

  return NextResponse.json({
    ok: true,
    week_start: weekStartDate,
    week_end: weekEndDate,
    results,
  });
}
