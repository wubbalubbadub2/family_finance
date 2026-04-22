// Goal math + rendering. Pure functions, no DB. Called from bot reply builders
// and the Sunday digest cron. All time math uses Asia/Almaty regardless of
// the runtime timezone (Vercel cron runs in UTC).

import { toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { ALMATY_TZ } from './constants';
import { formatTenge } from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  family_id: string;
  name: string;
  target_amount: number;
  deadline: string;        // DATE column, YYYY-MM-DD
  current_amount: number;
  status: 'active' | 'completed' | 'archived';
  created_at: string;      // timestamptz, ISO
}

export type GoalScheduleStatus = 'ahead' | 'on_track' | 'behind';

export interface GoalSchedule {
  status: GoalScheduleStatus;
  monthsElapsed: number;
  totalMonths: number;
  expected: number;
  progressPct: number;
  monthlyTarget: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date math, Almaty-scoped
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calendar-month difference between two instants, interpreted in the given tz.
 * Example: 2026-03-31T23:30 Almaty → 2026-04-01T00:30 Almaty = 1 month difference
 * (from March to April), NOT 2 (if naively converted through UTC).
 *
 * Rounds DOWN: partial months count as 1 if any part of the next calendar month
 * has been entered. This is intentional: at month boundary + 30 minutes, we
 * should already be in "month 1" of progress, not "month 0."
 */
export function monthsBetweenAlmaty(
  from: Date | string,
  to: Date | string,
  tz: string = ALMATY_TZ,
): number {
  const fromDate = typeof from === 'string' ? new Date(from) : from;
  const toDate = typeof to === 'string' ? new Date(to) : to;

  const fromY = parseInt(formatInTimeZone(fromDate, tz, 'yyyy'), 10);
  const fromM = parseInt(formatInTimeZone(fromDate, tz, 'M'), 10);
  const toY = parseInt(formatInTimeZone(toDate, tz, 'yyyy'), 10);
  const toM = parseInt(formatInTimeZone(toDate, tz, 'M'), 10);

  return (toY - fromY) * 12 + (toM - fromM);
}

/**
 * Week bounds in Almaty local time.
 * Returns the current week's Monday 00:00 Almaty and next Monday 00:00 Almaty
 * (half-open interval [start, end) for SQL BETWEEN).
 */
export function computeWeekBoundsAlmaty(now: Date = new Date(), tz: string = ALMATY_TZ): {
  weekStartUTC: Date;
  weekEndUTC: Date;
  weekStartDate: string;
  weekEndDate: string;
} {
  const almatyNow = toZonedTime(now, tz);
  // date-fns Monday = 1, Sunday = 0. Adjust so Monday is start of week.
  const dow = almatyNow.getDay(); // 0..6, 0=Sun
  const daysFromMonday = dow === 0 ? 6 : dow - 1;

  // Start of week (Monday 00:00 Almaty)
  const weekStartAlmaty = new Date(almatyNow);
  weekStartAlmaty.setDate(almatyNow.getDate() - daysFromMonday);
  weekStartAlmaty.setHours(0, 0, 0, 0);

  // End of week (next Monday 00:00 Almaty)
  const weekEndAlmaty = new Date(weekStartAlmaty);
  weekEndAlmaty.setDate(weekStartAlmaty.getDate() + 7);

  // Convert back to UTC Date objects (for Supabase queries that expect ISO timestamps)
  const weekStartDate = formatInTimeZone(weekStartAlmaty, tz, 'yyyy-MM-dd');
  const weekEndDate = formatInTimeZone(weekEndAlmaty, tz, 'yyyy-MM-dd');

  // For SQL: reconstruct midnight Almaty as UTC
  const weekStartUTC = new Date(`${weekStartDate}T00:00:00+05:00`);
  const weekEndUTC = new Date(`${weekEndDate}T00:00:00+05:00`);

  return { weekStartUTC, weekEndUTC, weekStartDate, weekEndDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// On-schedule computation
// ─────────────────────────────────────────────────────────────────────────────

const AHEAD_MULTIPLIER = 1.1;

/**
 * Compute whether a goal is on-schedule, ahead, or behind.
 *
 * Edge cases:
 * - Goal created today with 0 contributions → expected = target (single month window),
 *   current=0 → "behind" (returns a real status, not NaN).
 * - Deadline equals created_at (or before, which shouldn't happen but we guard) →
 *   total_months clamped to 1, avoids div-zero.
 * - months_elapsed capped at total_months so we don't compute > 100% expected.
 */
export function computeOnSchedule(
  currentAmount: number,
  targetAmount: number,
  createdAt: Date | string,
  deadline: Date | string,
  now: Date = new Date(),
  tz: string = ALMATY_TZ,
): GoalSchedule {
  const totalMonthsRaw = monthsBetweenAlmaty(createdAt, deadline, tz);
  const totalMonths = Math.max(1, totalMonthsRaw);

  const elapsedRaw = monthsBetweenAlmaty(createdAt, now, tz);
  // Clamp to [1, totalMonths] — the very first day of a goal is already "month 1"
  const monthsElapsed = Math.max(1, Math.min(totalMonths, elapsedRaw));

  const expected = Math.round(targetAmount * (monthsElapsed / totalMonths));
  const progressPct = targetAmount > 0
    ? Math.min(100, Math.round((currentAmount / targetAmount) * 100))
    : 0;

  // Monthly contribution target, rounded. Displayed as "надо X ₸/мес".
  const monthlyTarget = Math.round(targetAmount / totalMonths);

  let status: GoalScheduleStatus;
  if (currentAmount >= expected * AHEAD_MULTIPLIER) {
    status = 'ahead';
  } else if (currentAmount >= expected) {
    status = 'on_track';
  } else {
    status = 'behind';
  }

  return { status, monthsElapsed, totalMonths, expected, progressPct, monthlyTarget };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL_RU: Record<GoalScheduleStatus, string> = {
  ahead: 'опережаешь',
  on_track: 'идёшь в графике',
  behind: 'отстаёшь',
};

function isKillSwitchOff(): boolean {
  // Env-gated kill switch. If set to 'false', all progress line rendering is skipped.
  return process.env.GOAL_PROGRESS_ENABLED === 'false';
}

/**
 * Render the single-line goal progress string shown at the bottom of every
 * expense reply.
 *
 * Returns null if:
 * - no goal passed in (family has no active goal)
 * - GOAL_PROGRESS_ENABLED env is 'false' (kill switch)
 * - the underlying math throws (defense in depth; a silent catch means the
 *   expense reply still succeeds instead of 500-ing)
 *
 * Example output:
 *   "🎯 Отпуск 2026: 240 000 из 1 000 000 ₸ (24% · надо 125 000/мес · отстаёшь)"
 */
export function renderGoalProgress(
  goal: Goal | null | undefined,
  now: Date = new Date(),
  tz: string = ALMATY_TZ,
): string | null {
  if (!goal) return null;
  if (goal.status !== 'active') return null;
  if (isKillSwitchOff()) return null;

  try {
    const sched = computeOnSchedule(
      goal.current_amount,
      goal.target_amount,
      goal.created_at,
      goal.deadline,
      now,
      tz,
    );

    return `🎯 ${goal.name}: ${formatTenge(goal.current_amount)} из ${formatTenge(goal.target_amount)}`
      + ` (${sched.progressPct}% · надо ${formatTenge(sched.monthlyTarget)}/мес · ${STATUS_LABEL_RU[sched.status]})`;
  } catch (err) {
    // Kill switch + try/catch = defense in depth. If we somehow still NaN,
    // the user sees a normal expense reply without the goal line rather
    // than a crashed handler.
    console.error('[renderGoalProgress] error, suppressing line:', err);
    return null;
  }
}
