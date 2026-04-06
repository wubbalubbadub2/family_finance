import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { getMonthSummary, getActiveDebts } from '@/lib/db/queries';
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
          <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>🔌 Нет подключения к БД</p>
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

  // Fetch debts
  let debts: { id: string; name: string; original_amount: number; remaining_amount: number }[] = [];
  try { debts = await getActiveDebts(); } catch { /* table may not exist */ }

  let paceLine = '';
  let paceOver = false;
  if (hasPlan && days_elapsed > 0) {
    if (daily_actual > daily_budget) {
      paceOver = true;
      paceLine = `${formatTenge(daily_actual)}/день — выше плана`;
    } else if (safe_daily_remaining > 0) {
      paceLine = `${formatTenge(safe_daily_remaining)}/день до конца месяца`;
    }
  }

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">
        <Suspense><MonthPicker /></Suspense>

        {/* ── Compact hero ── */}
        <header className="px-6 pt-1 pb-6">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-sm mb-1">Расходы</p>
              <h1 className="display text-[36px]" style={{ color: 'var(--ink-1)' }}>
                {formatTenge(total_actual)}
              </h1>
            </div>
            <div className="text-right pb-0.5">
              <p className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                день {days_elapsed}/{days_in_month}
              </p>
              {hasPlan && (
                <p
                  className="text-[13px] font-semibold tabular mt-0.5"
                  style={{
                    color:
                      budgetPct >= 100 ? 'var(--red)' :
                      budgetPct >= 80 ? 'var(--amber)' :
                      'var(--green)',
                  }}
                >
                  {budgetPct}% из {formatTenge(total_planned)}
                </p>
              )}
            </div>
          </div>

          {hasPlan && <div className="mt-3"><Bar percentage={budgetPct} /></div>}

          {paceLine && (
            <p className="text-[11px] mt-2" style={{ color: paceOver ? 'var(--red)' : 'var(--ink-3)' }}>
              {paceLine}
            </p>
          )}

          {/* Income row */}
          {total_income > 0 && (
            <div className="flex gap-6 mt-4 pt-3">
              <div>
                <p className="label-sm mb-0.5">Доход</p>
                <p className="text-[14px] font-semibold tabular">{formatTenge(total_income)}</p>
              </div>
              <div>
                <p className="label-sm mb-0.5">Баланс</p>
                <p className="text-[14px] font-semibold tabular" style={{ color: balance >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {balance >= 0 ? '+' : ''}{formatTenge(balance)}
                </p>
              </div>
            </div>
          )}
        </header>

        {/* ── Categories ── */}
        {activeCats.length > 0 ? (
          <>
            <div className="px-6 pb-2 flex items-center justify-between">
              <h2 className="label-sm">Статьи</h2>
              <Link
                href={`/plan?year=${year}&month=${month}`}
                className="text-[11px] font-medium hover:opacity-60 transition-opacity"
                style={{ color: 'var(--ink-3)' }}
              >
                {hasPlan ? 'Изменить план →' : 'Установить план →'}
              </Link>
            </div>
            <div>
              {activeCats.map((c: CategorySummary, idx: number) => {
                const share = total_actual > 0 ? Math.round((c.actual / total_actual) * 100) : 0;
                return (
                  <div
                    key={c.category.slug}
                    className="flex items-center gap-3 px-6 py-3"
                    style={{ borderBottom: idx === activeCats.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
                  >
                    <span className="text-[18px] leading-none flex-shrink-0 w-6 text-center">{c.category.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--ink-2)' }}>
                          {c.category.name}
                          <span className="ml-1.5 font-normal text-[11px]" style={{ color: 'var(--ink-4)' }}>
                            {share}%
                          </span>
                        </span>
                        <span className="text-[13px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                          {formatTenge(c.actual)}
                        </span>
                      </div>
                      {c.planned > 0 ? (
                        <>
                          <Bar percentage={c.percentage} />
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px]" style={{ color: 'var(--ink-4)' }}>
                              {c.remaining > 0 ? `ост. ${formatTenge(c.remaining)}` : c.remaining < 0 ? `+${formatTenge(Math.abs(c.remaining))} сверх` : ''}
                            </span>
                            <span
                              className="text-[10px] font-medium tabular"
                              style={{ color: c.percentage >= 100 ? 'var(--red)' : c.percentage >= 80 ? 'var(--amber)' : 'var(--ink-4)' }}
                            >
                              {c.percentage}% плана
                            </span>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-center py-16 px-8">
            <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>
              Отправьте расход в бот: <span className="font-semibold" style={{ color: 'var(--ink-1)' }}>кофе 1200</span>
            </p>
          </div>
        )}
        {/* ── Debts section ── */}
        {debts.length > 0 && (
          <section className="px-6 pt-6 pb-4">
            <h2 className="label-sm mb-3">Долги</h2>
            {(() => {
              const totalDebt = debts.reduce((s, d) => s + d.remaining_amount, 0);
              const totalOriginal = debts.reduce((s, d) => s + d.original_amount, 0);
              const paidOff = totalOriginal - totalDebt;
              const pct = totalOriginal > 0 ? Math.round((paidOff / totalOriginal) * 100) : 0;
              return (
                <>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-[20px] font-semibold tabular display" style={{ color: 'var(--red)' }}>
                      {formatTenge(totalDebt)}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                      погашено {pct}%
                    </span>
                  </div>
                  <div className="w-full h-[2px] overflow-hidden mb-3" style={{ backgroundColor: 'var(--ink-6)' }}>
                    <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: 'var(--green)' }} />
                  </div>
                  {debts.map((d, idx) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between py-2"
                      style={{ borderBottom: idx === debts.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
                    >
                      <span className="text-[13px]" style={{ color: 'var(--ink-2)' }}>{d.name}</span>
                      <span className="text-[13px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                        {formatTenge(d.remaining_amount)}
                      </span>
                    </div>
                  ))}
                </>
              );
            })()}
          </section>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
