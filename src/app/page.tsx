import { currentMonthAlmaty, formatTenge, monthNameRu } from '@/lib/utils';
import { getMonthSummary } from '@/lib/db/queries';
import type { CategorySummary } from '@/types';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function getDashboardData() {
  const { year, month } = currentMonthAlmaty();
  try {
    return await getMonthSummary(year, month);
  } catch (e) {
    console.error('Dashboard error:', e);
    return null;
  }
}

/* ── Circular progress ring ── */
function Ring({ percentage, size = 140, stroke = 10 }: { percentage: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(percentage, 100);
  const offset = circumference - (progress / 100) * circumference;
  const color = percentage >= 100 ? '#ef4444' : percentage >= 80 ? '#f59e0b' : '#10b981';

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f3f4f6" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset}
        className="transition-all duration-1000 ease-out"
      />
    </svg>
  );
}

/* ── Small inline bar ── */
function MiniBar({ percentage }: { percentage: number }) {
  const p = Math.min(percentage, 100);
  const color = percentage >= 100 ? 'bg-red-500' : percentage >= 80 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="w-full bg-gray-100 rounded-full h-1">
      <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

export default async function Dashboard() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">🔌</div>
          <h1 className="text-lg font-semibold text-gray-800 mb-2">Нет подключения к БД</h1>
          <p className="text-sm text-gray-400 max-w-xs">Проверьте SUPABASE_URL и SUPABASE_SERVICE_KEY.</p>
        </div>
      </main>
    );
  }

  const {
    year, month, total_income,
    total_planned, total_actual, total_remaining,
    days_elapsed, days_in_month, categories,
  } = data;

  const hasPlan = total_planned > 0;
  const budgetPct = hasPlan ? Math.round((total_actual / total_planned) * 100) : 0;
  const activeCats = categories.filter((c: CategorySummary) => c.actual > 0 || c.planned > 0);
  const inactiveCats = categories.filter((c: CategorySummary) => c.actual === 0 && c.planned === 0);

  return (
    <main className="min-h-screen bg-white">
      <div className="max-w-lg mx-auto">

        {/* ── Top bar ── */}
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
              {monthNameRu(month)} {year}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
            День {days_elapsed} из {days_in_month}
          </div>
        </div>

        {/* ── Hero section ── */}
        <section className="px-6 py-8 flex flex-col items-center text-center">
          {hasPlan ? (
            <>
              <div className="relative">
                <Ring percentage={budgetPct} size={160} stroke={12} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold text-gray-900 tracking-tight">
                    {budgetPct}%
                  </span>
                  <span className="text-[11px] text-gray-400 mt-0.5">использовано</span>
                </div>
              </div>
              <div className="mt-5 space-y-1">
                <p className="text-2xl font-bold text-gray-900 tracking-tight">
                  {formatTenge(total_actual)}
                </p>
                <p className="text-sm text-gray-400">
                  из {formatTenge(total_planned)} бюджета
                </p>
              </div>
              {total_remaining >= 0 ? (
                <p className="mt-2 text-sm font-medium text-emerald-600">
                  Осталось {formatTenge(total_remaining)}
                </p>
              ) : (
                <p className="mt-2 text-sm font-medium text-red-500">
                  Перерасход {formatTenge(Math.abs(total_remaining))}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-4xl font-bold text-gray-900 tracking-tight">
                {formatTenge(total_actual)}
              </p>
              <p className="text-sm text-gray-400 mt-2">расходы за месяц</p>
              <Link
                href="/plan"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-full px-4 py-2 transition-colors"
              >
                Установить план &rarr;
              </Link>
            </>
          )}

          {total_income > 0 && (
            <div className="mt-4 flex items-center gap-4 text-sm">
              <span className="text-gray-400">Доход: <span className="font-semibold text-gray-700">{formatTenge(total_income)}</span></span>
              <span className="text-gray-300">|</span>
              <span className={`font-semibold ${total_income - total_actual >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {total_income - total_actual >= 0 ? '+' : ''}{formatTenge(total_income - total_actual)}
              </span>
            </div>
          )}
        </section>

        {/* ── Divider ── */}
        <div className="mx-6 border-t border-gray-100" />

        {/* ── Categories list ── */}
        {activeCats.length > 0 && (
          <section className="px-6 py-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Расходы</h2>
              {hasPlan && (
                <Link href="/plan" className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors">
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
                      <span className="text-sm font-semibold text-gray-900 tabular-nums">
                        {formatTenge(c.actual)}
                      </span>
                    </div>
                    {c.planned > 0 ? (
                      <>
                        <MiniBar percentage={c.percentage} />
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[11px] text-gray-400">
                            {c.remaining >= 0
                              ? `Осталось ${formatTenge(c.remaining)}`
                              : `+${formatTenge(Math.abs(c.remaining))} сверх плана`}
                          </span>
                          <span className={`text-[11px] font-medium tabular-nums ${
                            c.percentage >= 100 ? 'text-red-500' :
                            c.percentage >= 80 ? 'text-amber-500' :
                            'text-gray-400'
                          }`}>
                            {c.percentage}%
                          </span>
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

        {/* ── Inactive categories (compact) ── */}
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

        {/* ── Empty state ── */}
        {activeCats.length === 0 && (
          <section className="text-center py-16 px-6">
            <p className="text-4xl mb-3">💬</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              Отправьте расход в Telegram-бот:<br />
              <span className="font-medium text-gray-700">кофе 1200</span>
            </p>
          </section>
        )}

        {/* ── Bottom actions ── */}
        <div className="px-6 pb-8 pt-4">
          <div className="flex gap-2">
            <Link
              href="/plan"
              className="flex-1 text-center py-3 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 transition-colors"
            >
              {hasPlan ? 'Изменить план' : 'Установить план'}
            </Link>
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="text-center pb-8">
          <p className="text-[10px] text-gray-200 tracking-wide">tolagai &middot; {year}</p>
        </footer>
      </div>
    </main>
  );
}
