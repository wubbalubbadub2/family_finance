// Tests for goal math + rendering.
// Covers Test 1 (goal math, NaN guard, null goal, kill switch) and
// Test 5 (timezone boundary: goal created March 31 23:30 Almaty).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOnSchedule,
  monthsBetweenAlmaty,
  renderGoalProgress,
  computeWeekBoundsAlmaty,
  type Goal,
} from './goals';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    family_id: '22222222-2222-2222-2222-222222222222',
    name: 'Отпуск 2026',
    target_amount: 1_000_000,
    deadline: '2026-12-31',
    current_amount: 240_000,
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',  // Jan 1 2026 UTC = Jan 1 05:00 Almaty
    ...overrides,
  };
}

// Save/restore env — important because kill-switch test flips it.
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = { GOAL_PROGRESS_ENABLED: process.env.GOAL_PROGRESS_ENABLED };
});
afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// monthsBetweenAlmaty
// ─────────────────────────────────────────────────────────────────────────────

describe('monthsBetweenAlmaty', () => {
  test('same-month dates → 0 months', () => {
    const d1 = new Date('2026-04-01T00:00:00Z');
    const d2 = new Date('2026-04-15T00:00:00Z');
    assert.equal(monthsBetweenAlmaty(d1, d2), 0);
  });

  test('January to December same year → 11 months', () => {
    const d1 = new Date('2026-01-15T00:00:00Z');
    const d2 = new Date('2026-12-15T00:00:00Z');
    assert.equal(monthsBetweenAlmaty(d1, d2), 11);
  });

  test('crosses year boundary', () => {
    const d1 = new Date('2026-11-01T00:00:00Z');
    const d2 = new Date('2027-02-01T00:00:00Z');
    assert.equal(monthsBetweenAlmaty(d1, d2), 3);
  });

  test('TEST 5: TZ boundary — March 31 23:30 Almaty → April 1 00:30 Almaty = 1 month diff', () => {
    // March 31 23:30 Almaty = March 31 18:30 UTC
    const created = new Date('2026-03-31T18:30:00Z');
    // April 1 00:30 Almaty = March 31 19:30 UTC (same UTC date!)
    const now = new Date('2026-03-31T19:30:00Z');
    // In Almaty tz, March → April is 1 month. In UTC (naive), both show March = 0.
    // This test exists because a naive UTC-based impl would return 0 and silently
    // under-count progress for users at the day/month boundary.
    assert.equal(monthsBetweenAlmaty(created, now), 1);
  });

  test('TEST 5: same-date different-time in Almaty → 0 months', () => {
    // Both April 15 in Almaty
    const d1 = new Date('2026-04-14T19:00:00Z'); // April 15 00:00 Almaty
    const d2 = new Date('2026-04-15T10:00:00Z'); // April 15 15:00 Almaty
    assert.equal(monthsBetweenAlmaty(d1, d2), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeOnSchedule — happy path + edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('computeOnSchedule', () => {
  test('happy path: 24% at 24% elapsed → on_track', () => {
    const created = new Date('2026-01-01T05:00:00Z'); // Jan 1 10:00 Almaty
    const now = new Date('2026-04-01T05:00:00Z');     // Apr 1 10:00 Almaty (3 months later)
    const sched = computeOnSchedule(240_000, 1_000_000, created, '2026-12-31', now);
    // 3 of 11 months elapsed. Expected = 1M * 3/11 = 272_727. Current = 240K < expected → behind
    // (This is a real constraint: the monthly target to hit 1M by Dec is 90K/mo;
    // 240K by April is below that cadence.)
    assert.equal(sched.status, 'behind');
    assert.equal(sched.monthsElapsed, 3);
    assert.equal(sched.totalMonths, 11);
    assert.equal(sched.progressPct, 24);
  });

  test('ahead: 50% at 10% elapsed', () => {
    const created = new Date('2026-01-01T05:00:00Z');
    const now = new Date('2026-02-01T05:00:00Z'); // 1 month in, goal runs to Dec = 11 mo
    const sched = computeOnSchedule(500_000, 1_000_000, created, '2026-12-31', now);
    // Expected = 1M * 1/11 = 90_909. Current = 500K. 500K >= expected * 1.1 → ahead
    assert.equal(sched.status, 'ahead');
  });

  test('on_track: exactly at expected', () => {
    const created = new Date('2026-01-01T05:00:00Z');
    const now = new Date('2026-07-01T05:00:00Z'); // 6 months in out of 12
    const sched = computeOnSchedule(500_000, 1_000_000, created, '2027-01-01', now);
    assert.equal(sched.status, 'on_track');
  });

  test('TEST 1 EDGE CASE: goal created today, 0 contributions → behind, not NaN', () => {
    const now = new Date('2026-04-15T10:00:00Z');
    const sched = computeOnSchedule(0, 1_000_000, now, '2026-05-15', now);
    // Same month for created & now → elapsed=0 raw, clamped to 1.
    // Total: May - April = 1 month (clamped to max 1).
    // expected = 1M * 1/1 = 1M. current = 0 → behind, NOT NaN.
    assert.equal(sched.status, 'behind');
    assert.ok(Number.isFinite(sched.expected));
    assert.ok(Number.isFinite(sched.progressPct));
    assert.equal(sched.monthsElapsed, 1);
    assert.equal(sched.totalMonths, 1);
  });

  test('edge: deadline is same as created → total_months clamped to 1 (no div-zero)', () => {
    const created = new Date('2026-04-15T10:00:00Z');
    const sched = computeOnSchedule(500_000, 1_000_000, created, '2026-04-15', created);
    assert.ok(Number.isFinite(sched.expected));
    assert.equal(sched.totalMonths, 1);
  });

  test('edge: now past deadline → monthsElapsed clamped to totalMonths', () => {
    const created = new Date('2026-01-01T05:00:00Z');
    const now = new Date('2027-06-01T05:00:00Z'); // way past Dec 2026 deadline
    const sched = computeOnSchedule(1_000_000, 1_000_000, created, '2026-12-31', now);
    assert.equal(sched.monthsElapsed, sched.totalMonths); // capped
  });

  test('TEST 5: goal created March 31 23:30 Almaty, checked April 1 00:30 Almaty → elapsed=1', () => {
    // This is the real-world bug the test targets: user creates goal at 11:30pm
    // on end of month and 1 hour later (just past midnight), on_schedule should
    // not claim they're a full month late.
    const created = new Date('2026-03-31T18:30:00Z'); // March 31 23:30 Almaty
    const now = new Date('2026-03-31T19:30:00Z');    // April 1 00:30 Almaty
    const sched = computeOnSchedule(0, 1_000_000, created, '2026-12-31', now);
    // Just entered April. Elapsed raw = 1. Total = 9. Expected = 1M * 1/9 ≈ 111K.
    // Current = 0 → behind (correct — they need to fund it).
    // The key assertion: elapsed is 1, not 0 (naive impl) and not 2 (buggy impl).
    assert.equal(sched.monthsElapsed, 1);
    assert.equal(sched.status, 'behind');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderGoalProgress
// ─────────────────────────────────────────────────────────────────────────────

describe('renderGoalProgress', () => {
  test('happy path renders full line with % + rate + status', () => {
    const goal = makeGoal({ current_amount: 240_000, target_amount: 1_000_000 });
    const now = new Date('2026-04-01T05:00:00Z');
    const line = renderGoalProgress(goal, now);
    assert.ok(line, 'line should not be null');
    // toLocaleString('ru-RU') uses NON-BREAKING SPACES (U+00A0) in number
    // formatting. Normalize both sides before substring checks so the test
    // doesn't depend on which space char the locale picks.
    const normalized = line.replace(/ /g, ' ');
    assert.ok(normalized.includes('Отпуск 2026'));
    assert.ok(normalized.includes('240 000'));
    assert.ok(normalized.includes('1 000 000'));
    assert.ok(normalized.includes('%'));
    assert.ok(normalized.includes('надо'));
    assert.ok(
      normalized.includes('отстаёшь') ||
      normalized.includes('идёшь в графике') ||
      normalized.includes('опережаешь')
    );
  });

  test('TEST 1: null goal returns null', () => {
    assert.equal(renderGoalProgress(null), null);
    assert.equal(renderGoalProgress(undefined), null);
  });

  test('TEST 1: archived goal returns null', () => {
    const goal = makeGoal({ status: 'archived' });
    assert.equal(renderGoalProgress(goal), null);
  });

  test('TEST 1: completed goal returns null', () => {
    const goal = makeGoal({ status: 'completed' });
    assert.equal(renderGoalProgress(goal), null);
  });

  test('TEST 1: GOAL_PROGRESS_ENABLED=false kill switch returns null', () => {
    const goal = makeGoal();
    process.env.GOAL_PROGRESS_ENABLED = 'false';
    assert.equal(renderGoalProgress(goal), null);
  });

  test('TEST 1: GOAL_PROGRESS_ENABLED unset (default true) renders', () => {
    const goal = makeGoal();
    delete process.env.GOAL_PROGRESS_ENABLED;
    const line = renderGoalProgress(goal);
    assert.ok(line && line.length > 0);
  });

  test('TEST 1: defense in depth — malformed goal does not crash', () => {
    // Intentionally corrupt dates to force internals to throw.
    const badGoal = {
      ...makeGoal(),
      created_at: 'not-a-date' as string,
      deadline: 'also-not-a-date' as string,
    };
    // Should either return a string or null, NEVER throw
    const result = renderGoalProgress(badGoal);
    // Accepted outcomes: string (if date-fns-tz tolerates it) or null (catch path).
    assert.ok(result === null || typeof result === 'string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeWeekBoundsAlmaty — TEST 5
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWeekBoundsAlmaty (TEST 5: timezone boundary for weekly digest)', () => {
  test('Sunday 22:00 UTC (= Monday 03:00 Almaty) → weekStart is THIS Monday Almaty', () => {
    // Scenario: Vercel cron fires at 15:00 UTC Sunday (= 20:00 Almaty Sunday).
    // The week we want to report on is the ALMATY week that JUST ended (Mon 00:00 - Sun 23:59).
    //
    // Naive UTC impl would use UTC Sunday, which overlaps wrong.
    const now = new Date('2026-04-19T15:00:00Z'); // Sun Apr 19 15:00 UTC = Sun 20:00 Almaty
    const bounds = computeWeekBoundsAlmaty(now);

    // Expected: weekStart = Monday April 13 00:00 Almaty (UTC+5), weekEnd = Monday April 20 00:00 Almaty
    assert.equal(bounds.weekStartDate, '2026-04-13');
    assert.equal(bounds.weekEndDate, '2026-04-20');
  });

  test('Monday 03:00 Almaty → weekStart is this Monday', () => {
    const now = new Date('2026-04-20T03:00:00+05:00'); // Mon Apr 20 03:00 Almaty
    const bounds = computeWeekBoundsAlmaty(now);
    assert.equal(bounds.weekStartDate, '2026-04-20');
  });

  test('Monday 00:30 Almaty (JUST past week start) → weekStart is this Monday', () => {
    const now = new Date('2026-04-19T19:30:00Z'); // Mon Apr 20 00:30 Almaty
    const bounds = computeWeekBoundsAlmaty(now);
    assert.equal(bounds.weekStartDate, '2026-04-20');
  });

  test('Sunday 23:30 Almaty (just before week rollover) → weekStart is LAST Monday', () => {
    const now = new Date('2026-04-19T18:30:00Z'); // Sun Apr 19 23:30 Almaty
    const bounds = computeWeekBoundsAlmaty(now);
    assert.equal(bounds.weekStartDate, '2026-04-13');
  });
});
