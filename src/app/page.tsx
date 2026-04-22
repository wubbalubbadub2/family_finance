import { currentMonthAlmaty, formatTenge, monthNameRu } from '@/lib/utils';
import { getMonthSummary, getActiveDebts } from '@/lib/db/queries';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';
import type { CategorySummary } from '@/types';
import Link from 'next/link';
import MonthPickerWrapper from '@/components/month-picker-wrapper';


export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

function Bar({ percentage, color = 'var(--ink-1)' }: { percentage: number; color?: string }) {
  const p = Math.min(percentage, 100);
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
    data = await getMonthSummary(year, month, DEFAULT_FAMILY_ID);
  } catch {
    return (
      <main className="min-h-screen flex items-center justify-center pb-20" style={{ backgroundColor: 'var(--bg)' }}>
        <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>🔌 Нет подключения к БД</p>
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

  let debts: { id: string; name: string; original_amount: number; remaining_amount: number }[] = [];
  try { debts = await getActiveDebts(DEFAULT_FAMILY_ID); } catch { /* table may not exist */ }
  const totalDebt = debts.reduce((s, d) => s + d.remaining_amount, 0);

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">

        <MonthPickerWrapper />

        {/* ── Summary grid ── */}
        <section className="px-6 pt-1 pb-4">
          <p className="label-sm mb-3">{monthNameRu(month)} {year} · день {days_elapsed}/{days_in_month}</p>

          {/* 2x2 grid: income, expenses, balance, debts */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {/* Income */}
            <Link href={`/income?year=${year}&month=${month}`} className="block">
              <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: 'var(--ink-4)' }}>
                Доходы
              </p>
              <p className="text-[22px] font-semibold tabular" style={{ color: total_income > 0 ? 'var(--green)' : 'var(--ink-4)', letterSpacing: '-0.02em' }}>
                {total_income > 0 ? formatTenge(total_income) : '—'}
              </p>
            </Link>

            {/* Expenses */}
            <Link href={`/transactions?year=${year}&month=${month}`} className="block">
              <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: 'var(--ink-4)' }}>
                Расходы
              </p>
              <p className="text-[22px] font-semibold tabular" style={{ color: 'var(--ink-1)', letterSpacing: '-0.02em' }}>
                {formatTenge(total_actual)}
              </p>
            </Link>

            {/* Balance */}
            {total_income > 0 && (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: 'var(--ink-4)' }}>
                  Баланс
                </p>
                <p className="text-[22px] font-semibold tabular" style={{ color: balance >= 0 ? 'var(--green)' : 'var(--red)', letterSpacing: '-0.02em' }}>
                  {balance >= 0 ? '+' : ''}{formatTenge(balance)}
                </p>
              </div>
            )}

            {/* Debts */}
            {totalDebt > 0 && (
              <Link href="/debts" className="block">
                <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: 'var(--ink-4)' }}>
                  Долги
                </p>
                <p className="text-[22px] font-semibold tabular" style={{ color: 'var(--red)', letterSpacing: '-0.02em' }}>
                  {formatTenge(totalDebt)}
                </p>
              </Link>
            )}
          </div>
        </section>

        {/* ── Budget progress ── */}
        {hasPlan && (
          <section className="px-6 pb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                Бюджет: {formatTenge(total_actual)} из {formatTenge(total_planned)}
              </span>
              <span
                className="text-[11px] font-semibold tabular"
                style={{
                  color: budgetPct >= 100 ? 'var(--red)' : budgetPct >= 80 ? 'var(--amber)' : 'var(--green)',
                }}
              >
                {budgetPct}%
              </span>
            </div>
            <Bar
              percentage={budgetPct}
              color={budgetPct >= 100 ? 'var(--red)' : budgetPct >= 80 ? 'var(--amber)' : 'var(--ink-1)'}
            />
            {paceLine && (
              <p className="text-[11px] mt-1.5" style={{ color: paceOver ? 'var(--red)' : 'var(--ink-3)' }}>
                {paceLine}
              </p>
            )}
          </section>
        )}

        {/* ── Category breakdown ── */}
        {activeCats.length > 0 ? (
          <section className="pt-2">
            <div className="px-6 pb-2 flex items-center justify-between">
              <h2 className="label-sm">Расходы по статьям</h2>
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
                      {c.planned > 0 && (
                        <>
                          <Bar
                            percentage={c.percentage}
                            color={c.percentage >= 100 ? 'var(--red)' : c.percentage >= 80 ? 'var(--amber)' : 'var(--ink-1)'}
                          />
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
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <div className="text-center py-12 px-8">
            <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>
              Отправьте расход в бот: <span className="font-semibold" style={{ color: 'var(--ink-1)' }}>кофе 1200</span>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
