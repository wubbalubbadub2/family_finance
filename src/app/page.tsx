import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { getMonthSummary } from '@/lib/db/queries';
import type { CategorySummary } from '@/types';
import Link from 'next/link';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

function Ring({ percentage, size = 144, stroke = 10 }: { percentage: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(percentage, 100);
  const offset = circumference - (progress / 100) * circumference;
  const color = percentage >= 100 ? '#ef4444' : percentage >= 80 ? '#f59e0b' : '#10b981';
  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f1f3f5" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset}
        className="transition-all duration-1000 ease-out"
      />
    </svg>
  );
}

function MiniBar({ percentage }: { percentage: number }) {
  const p = Math.min(percentage, 100);
  const color = percentage >= 100 ? '#ef4444' : percentage >= 80 ? '#f59e0b' : '#10b981';
  return (
    <div className="w-full rounded-full h-[3px] overflow-hidden" style={{ backgroundColor: 'rgba(15,16,17,0.05)' }}>
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${p}%`, backgroundColor: color }} />
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
      <main className="min-h-screen flex items-center justify-center pb-20" style={{ backgroundColor: 'var(--bg-base)' }}>
        <div className="text-center p-8">
          <div className="text-4xl mb-4">🔌</div>
          <h1 className="text-[15px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Нет подключения к БД
          </h1>
        </div>
        <Suspense><Nav /></Suspense>
      </main>
    );
  }

  const {
    total_income, total_planned, total_actual, total_remaining,
    days_elapsed, days_in_month, daily_budget, daily_actual,
    safe_daily_remaining, categories,
  } = data;

  const hasPlan = total_planned > 0;
  const budgetPct = hasPlan ? Math.round((total_actual / total_planned) * 100) : 0;
  const activeCats = categories.filter((c: CategorySummary) => c.actual > 0 || c.planned > 0);
  const inactiveCats = categories.filter((c: CategorySummary) => c.actual === 0 && c.planned === 0);

  let paceText = '';
  let paceOver = false;
  if (hasPlan && days_elapsed > 0) {
    if (daily_actual > daily_budget) {
      paceOver = true;
      paceText = `${formatTenge(daily_actual)}/день — бюджет ${formatTenge(daily_budget)}/день`;
    } else if (safe_daily_remaining > 0) {
      paceText = `Можно тратить ${formatTenge(safe_daily_remaining)}/день`;
    }
  }

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg-base)' }}>
      <div className="max-w-lg mx-auto">

        <Suspense><MonthPicker /></Suspense>

        {/* Hero */}
        <section className="px-6 py-6 flex flex-col items-center text-center">
          {hasPlan ? (
            <>
              <div className="relative">
                <Ring percentage={budgetPct} size={148} stroke={10} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[32px] font-semibold tabular tracking-display" style={{ color: 'var(--text-primary)' }}>
                    {budgetPct}%
                  </span>
                  <span className="text-[10px] mt-0.5 uppercase tracking-[0.08em] font-medium" style={{ color: 'var(--text-quaternary)' }}>
                    использовано
                  </span>
                </div>
              </div>
              <p className="mt-5 text-[24px] font-semibold tabular tracking-tight-more" style={{ color: 'var(--text-primary)' }}>
                {formatTenge(total_actual)}
              </p>
              <p className="text-[13px] mt-0.5" style={{ color: 'var(--text-quaternary)' }}>
                из {formatTenge(total_planned)}
              </p>
              {total_remaining > 0 ? (
                <p className="mt-2 text-[13px] font-medium" style={{ color: 'var(--success)' }}>
                  Осталось {formatTenge(total_remaining)}
                </p>
              ) : total_remaining < 0 ? (
                <p className="mt-2 text-[13px] font-medium" style={{ color: 'var(--danger)' }}>
                  Перерасход {formatTenge(Math.abs(total_remaining))}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[40px] font-semibold tabular tracking-display" style={{ color: 'var(--text-primary)' }}>
                {formatTenge(total_actual)}
              </p>
              <p className="text-[13px] mt-1.5" style={{ color: 'var(--text-quaternary)' }}>
                {total_actual > 0 ? `расходы за месяц` : 'нет расходов'}
              </p>
              <Link
                href={`/plan?year=${year}&month=${month}`}
                className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium rounded-full px-4 py-1.5 transition-colors"
                style={{
                  backgroundColor: 'var(--bg-subtle)',
                  color: 'var(--text-primary)',
                }}
              >
                Установить план <span style={{ color: 'var(--text-tertiary)' }}>→</span>
              </Link>
            </>
          )}

          {/* Income line */}
          {total_income > 0 && (
            <div className="mt-3 flex items-center gap-2 text-[12px]">
              <span style={{ color: 'var(--text-quaternary)' }}>
                Доход: <span className="font-semibold tabular" style={{ color: 'var(--text-secondary)' }}>{formatTenge(total_income)}</span>
              </span>
              <span style={{ color: 'var(--border-standard)' }}>·</span>
              <span
                className="font-semibold tabular"
                style={{ color: total_income - total_actual >= 0 ? 'var(--success)' : 'var(--danger)' }}
              >
                {total_income - total_actual >= 0 ? '+' : ''}{formatTenge(total_income - total_actual)}
              </span>
            </div>
          )}

          {/* Pace insight */}
          {paceText && (
            <p
              className="mt-3 text-[11px] font-medium px-3 py-1.5 rounded-full"
              style={{
                backgroundColor: paceOver ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
                color: paceOver ? 'var(--danger)' : 'var(--success)',
              }}
            >
              {paceOver ? '⚡' : '✨'} {paceText}
            </p>
          )}

          <p className="mt-3 text-[10px] uppercase tracking-[0.08em] font-medium" style={{ color: 'var(--text-quaternary)' }}>
            День {days_elapsed} из {days_in_month}
          </p>
        </section>

        {/* Categories */}
        {activeCats.length > 0 && (
          <section className="px-5 pb-2">
            <div className="flex items-center justify-between mb-3 px-1">
              <h2 className="text-[10px] uppercase tracking-[0.08em] font-semibold" style={{ color: 'var(--text-quaternary)' }}>
                Статьи расходов
              </h2>
              {hasPlan && (
                <Link
                  href={`/plan?year=${year}&month=${month}`}
                  className="text-[11px] transition-colors hover:opacity-80"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Изменить план
                </Link>
              )}
            </div>
            <div className="space-y-1.5">
              {activeCats.map((c: CategorySummary) => (
                <div
                  key={c.category.slug}
                  className="flex items-center gap-3 rounded-[10px] px-4 py-3"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <span className="text-[20px] w-8 text-center flex-shrink-0 leading-none">{c.category.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {c.category.name}
                      </span>
                      <span className="text-[13px] font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
                        {formatTenge(c.actual)}
                      </span>
                    </div>
                    {c.planned > 0 ? (
                      <>
                        <MiniBar percentage={c.percentage} />
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[10px]" style={{ color: 'var(--text-quaternary)' }}>
                            {c.remaining > 0
                              ? `Осталось ${formatTenge(c.remaining)}`
                              : c.remaining < 0
                                ? `+${formatTenge(Math.abs(c.remaining))} сверх`
                                : 'В точку'}
                          </span>
                          <span
                            className="text-[10px] font-medium tabular"
                            style={{
                              color:
                                c.percentage >= 100 ? 'var(--danger)' :
                                c.percentage >= 80 ? 'var(--warning)' :
                                'var(--text-quaternary)',
                            }}
                          >
                            {c.percentage}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="text-[10px]" style={{ color: 'var(--text-quaternary)' }}>без плана</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Inactive categories */}
        {inactiveCats.length > 0 && activeCats.length > 0 && (
          <section className="px-5 py-4">
            <div className="flex flex-wrap gap-1.5">
              {inactiveCats.map((c: CategorySummary) => (
                <span
                  key={c.category.slug}
                  className="text-[10px] rounded-full px-2.5 py-1"
                  style={{
                    color: 'var(--text-quaternary)',
                    backgroundColor: 'var(--bg-subtle)',
                  }}
                >
                  {c.category.emoji} {c.category.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {activeCats.length === 0 && (
          <section className="text-center py-16 px-6">
            <p className="text-[32px] mb-3">💬</p>
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              Отправьте расход в Telegram-бот:<br />
              <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>кофе 1200</span>
            </p>
          </section>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
