import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge, monthNameRu } from '@/lib/utils';
import { getMonthSummary } from '@/lib/db/queries';
import type { CategorySummary } from '@/types';
import Link from 'next/link';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

function Bar({ percentage }: { percentage: number }) {
  const p = Math.min(percentage, 100);
  const color =
    percentage >= 100 ? 'var(--red)' :
    percentage >= 80 ? 'var(--amber)' :
    'var(--ink-1)';
  return (
    <div className="w-full h-[2px] overflow-hidden" style={{ backgroundColor: 'var(--ink-6)' }}>
      <div className="h-full transition-all duration-700" style={{ width: `${p}%`, backgroundColor: color }} />
    </div>
  );
}

export default async function Dashboard({ searchParams }: PageProps) {
  const params = await searchParams;
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(params.year ?? '') || nowYear;
  const month = parseInt(params.month ?? '') || nowMonth;

  let data;
  try {
    data = await getMonthSummary(year, month);
  } catch {
    return (
      <main className="min-h-screen flex items-center justify-center pb-20" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center p-8">
          <div className="text-4xl mb-4">🔌</div>
          <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>Нет подключения к БД</p>
        </div>
        <Suspense><Nav /></Suspense>
      </main>
    );
  }

  const {
    total_income, total_planned, total_actual,
    days_elapsed, days_in_month, daily_budget, daily_actual,
    safe_daily_remaining, categories,
  } = data;

  const hasPlan = total_planned > 0;
  const budgetPct = hasPlan ? Math.round((total_actual / total_planned) * 100) : 0;
  const activeCats = categories.filter((c: CategorySummary) => c.actual > 0 || c.planned > 0);
  const balance = total_income - total_actual;

  // Pace insight
  let paceLine = '';
  let paceOver = false;
  if (hasPlan && days_elapsed > 0) {
    if (daily_actual > daily_budget) {
      paceOver = true;
      paceLine = `Темп ${formatTenge(daily_actual)} в день — выше плана`;
    } else if (safe_daily_remaining > 0) {
      paceLine = `${formatTenge(safe_daily_remaining)} в день до конца месяца`;
    }
  }

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">
        <Suspense><MonthPicker /></Suspense>

        {/* ── Editorial hero ── */}
        <header className="px-6 pt-4 pb-10">
          <p className="overline mb-3">
            {monthNameRu(month)} · день {days_elapsed} из {days_in_month}
          </p>
          <h1 className="display-lg text-[56px]" style={{ color: 'var(--ink-1)' }}>
            {formatTenge(total_actual)}
          </h1>
          {hasPlan ? (
            <div className="flex items-baseline gap-3 mt-3">
              <span className="text-[14px]" style={{ color: 'var(--ink-3)' }}>
                из {formatTenge(total_planned)}
              </span>
              <span
                className="text-[13px] font-semibold tabular"
                style={{
                  color:
                    budgetPct >= 100 ? 'var(--red)' :
                    budgetPct >= 80 ? 'var(--amber)' :
                    'var(--green)',
                }}
              >
                {budgetPct}%
              </span>
            </div>
          ) : (
            <p className="text-[14px] mt-3" style={{ color: 'var(--ink-3)' }}>
              расходы за месяц
            </p>
          )}

          {/* Single thin progress bar */}
          {hasPlan && (
            <div className="mt-5">
              <Bar percentage={budgetPct} />
            </div>
          )}

          {/* Pace insight */}
          {paceLine && (
            <p
              className="text-[12px] mt-4"
              style={{ color: paceOver ? 'var(--red)' : 'var(--ink-3)' }}
            >
              {paceLine}
            </p>
          )}

          {/* Income line */}
          {total_income > 0 && (
            <div className="flex items-baseline gap-4 mt-5 pt-5" style={{ borderTop: '1px solid var(--ink-6)' }}>
              <div className="flex-1">
                <p className="overline mb-1">Доход</p>
                <p className="text-[15px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                  {formatTenge(total_income)}
                </p>
              </div>
              <div className="flex-1">
                <p className="overline mb-1">Баланс</p>
                <p
                  className="text-[15px] font-semibold tabular"
                  style={{ color: balance >= 0 ? 'var(--green)' : 'var(--red)' }}
                >
                  {balance >= 0 ? '+' : ''}{formatTenge(balance)}
                </p>
              </div>
            </div>
          )}
        </header>

        {/* ── Category list ── */}
        {activeCats.length > 0 ? (
          <>
            <div className="px-6 pb-3 flex items-center justify-between">
              <h2 className="overline">Статьи</h2>
              <Link
                href={`/plan?year=${year}&month=${month}`}
                className="text-[11px] font-medium transition-opacity hover:opacity-60"
                style={{ color: 'var(--ink-3)' }}
              >
                {hasPlan ? 'Изменить план' : 'Установить план'} →
              </Link>
            </div>

            <div style={{ borderTop: '1px solid var(--ink-6)' }}>
              {activeCats.map((c: CategorySummary, idx: number) => (
                <div
                  key={c.category.slug}
                  className="flex items-center gap-4 px-6 py-4"
                  style={{
                    borderBottom: idx === activeCats.length - 1 ? 'none' : '1px solid var(--ink-6)',
                  }}
                >
                  <span className="text-[20px] leading-none flex-shrink-0 w-7 text-center">
                    {c.category.emoji}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-[14px] font-medium" style={{ color: 'var(--ink-2)' }}>
                        {c.category.name}
                      </span>
                      <span className="text-[14px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                        {formatTenge(c.actual)}
                      </span>
                    </div>
                    {c.planned > 0 ? (
                      <>
                        <Bar percentage={c.percentage} />
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                            {c.remaining > 0
                              ? `осталось ${formatTenge(c.remaining)}`
                              : c.remaining < 0
                                ? `+${formatTenge(Math.abs(c.remaining))} сверх`
                                : 'в точку'}
                          </span>
                          <span
                            className="text-[11px] font-medium tabular"
                            style={{
                              color:
                                c.percentage >= 100 ? 'var(--red)' :
                                c.percentage >= 80 ? 'var(--amber)' :
                                'var(--ink-4)',
                            }}
                          >
                            {c.percentage}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="text-[11px]" style={{ color: 'var(--ink-4)' }}>без плана</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-center py-20 px-8">
            <p className="text-[32px] mb-4">💬</p>
            <p className="text-[14px] mb-1" style={{ color: 'var(--ink-3)' }}>
              Отправьте расход в Telegram
            </p>
            <p className="text-[14px] font-semibold" style={{ color: 'var(--ink-1)' }}>
              кофе 1200
            </p>
          </div>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
