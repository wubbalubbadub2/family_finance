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

function Ring({ percentage, size = 140, stroke = 10 }: { percentage: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(percentage, 100);
  const offset = circumference - (progress / 100) * circumference;
  const color = percentage >= 100 ? '#ef4444' : percentage >= 80 ? '#f59e0b' : '#10b981';
  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f3f4f6" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
        className="transition-all duration-1000 ease-out" />
    </svg>
  );
}

function MiniBar({ percentage }: { percentage: number }) {
  const p = Math.min(percentage, 100);
  const color = percentage >= 100 ? 'bg-red-500' : percentage >= 80 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="w-full bg-gray-100 rounded-full h-1">
      <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${p}%` }} />
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
      <main className="min-h-screen bg-white flex items-center justify-center pb-20">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">🔌</div>
          <h1 className="text-lg font-semibold text-gray-800 mb-2">Нет подключения к БД</h1>
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

  // Pace insight text
  let paceText = '';
  if (hasPlan && days_elapsed > 0) {
    if (daily_actual > daily_budget) {
      paceText = `Темп: ${formatTenge(daily_actual)}/день — бюджет: ${formatTenge(daily_budget)}/день`;
    } else if (safe_daily_remaining > 0) {
      paceText = `Можно тратить ${formatTenge(safe_daily_remaining)}/день`;
    }
  }

  return (
    <main className="min-h-screen bg-white pb-20">
      <div className="max-w-lg mx-auto">
        {/* Month picker */}
        <Suspense>
          <MonthPicker />
        </Suspense>

        {/* Hero */}
        <section className="px-6 py-6 flex flex-col items-center text-center">
          {hasPlan ? (
            <>
              <div className="relative">
                <Ring percentage={budgetPct} size={150} stroke={11} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold text-gray-900 tracking-tight">{budgetPct}%</span>
                  <span className="text-[11px] text-gray-400 mt-0.5">использовано</span>
                </div>
              </div>
              <p className="mt-4 text-2xl font-bold text-gray-900 tracking-tight">{formatTenge(total_actual)}</p>
              <p className="text-sm text-gray-400">из {formatTenge(total_planned)}</p>
              {total_remaining > 0 ? (
                <p className="mt-1.5 text-sm font-medium text-emerald-600">Осталось {formatTenge(total_remaining)}</p>
              ) : total_remaining < 0 ? (
                <p className="mt-1.5 text-sm font-medium text-red-500">Перерасход {formatTenge(Math.abs(total_remaining))}</p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-4xl font-bold text-gray-900 tracking-tight">{formatTenge(total_actual)}</p>
              <p className="text-sm text-gray-400 mt-2">
                {total_actual > 0 ? 'расходы за месяц' : 'нет расходов'}
              </p>
              <Link href={`/plan?year=${year}&month=${month}`}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-full px-4 py-2 transition-colors">
                Установить план &rarr;
              </Link>
            </>
          )}

          {/* Income */}
          {total_income > 0 && (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <span className="text-gray-400">Доход: <span className="font-semibold text-gray-700">{formatTenge(total_income)}</span></span>
              <span className={`font-semibold ${total_income - total_actual >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {total_income - total_actual >= 0 ? '+' : ''}{formatTenge(total_income - total_actual)}
              </span>
            </div>
          )}

          {/* Pace insight */}
          {paceText && (
            <p className={`mt-3 text-xs px-3 py-1.5 rounded-full ${
              daily_actual > daily_budget ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'
            }`}>
              {daily_actual > daily_budget ? '⚡' : '✨'} {paceText}
            </p>
          )}

          {/* Day counter */}
          <p className="mt-3 text-[11px] text-gray-300">
            День {days_elapsed} из {days_in_month}
          </p>
        </section>

        <div className="mx-6 border-t border-gray-100" />

        {/* Categories */}
        {activeCats.length > 0 && (
          <section className="px-6 py-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Статьи расходов</h2>
              {hasPlan && (
                <Link href={`/plan?year=${year}&month=${month}`} className="text-[11px] text-gray-400 hover:text-gray-600">
                  Изменить план
                </Link>
              )}
            </div>
            <div className="space-y-1">
              {activeCats.map((c: CategorySummary) => (
                <div key={c.category.slug} className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
                  <span className="text-xl w-8 text-center flex-shrink-0">{c.category.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-800">{c.category.name}</span>
                      <span className="text-sm font-semibold text-gray-900 tabular-nums">{formatTenge(c.actual)}</span>
                    </div>
                    {c.planned > 0 ? (
                      <>
                        <MiniBar percentage={c.percentage} />
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[11px] text-gray-400">
                            {c.remaining > 0 ? `Осталось ${formatTenge(c.remaining)}` : c.remaining < 0 ? `+${formatTenge(Math.abs(c.remaining))} сверх` : 'В точку'}
                          </span>
                          <span className={`text-[11px] font-medium tabular-nums ${
                            c.percentage >= 100 ? 'text-red-500' : c.percentage >= 80 ? 'text-amber-500' : 'text-gray-400'
                          }`}>{c.percentage}%</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-[11px] text-gray-300 mt-0.5">без плана</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Inactive */}
        {inactiveCats.length > 0 && activeCats.length > 0 && (
          <section className="px-6 pb-5">
            <div className="flex flex-wrap gap-1.5">
              {inactiveCats.map((c: CategorySummary) => (
                <span key={c.category.slug} className="text-[11px] text-gray-300 bg-gray-50 rounded-full px-2.5 py-1">
                  {c.category.emoji} {c.category.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Empty */}
        {activeCats.length === 0 && (
          <section className="text-center py-16 px-6">
            <p className="text-4xl mb-3">💬</p>
            <p className="text-sm text-gray-500">Отправьте расход в Telegram-бот:<br /><span className="font-medium text-gray-700">кофе 1200</span></p>
          </section>
        )}

        {/* Action */}
        {!hasPlan && total_actual > 0 && (
          <div className="px-6 pb-6">
            <Link href={`/plan?year=${year}&month=${month}`}
              className="block text-center py-3 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 transition-colors">
              Установить план
            </Link>
          </div>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
