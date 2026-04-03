import { currentMonthAlmaty, formatTenge, monthNameRu } from '@/lib/utils';
import { getMonthSummary } from '@/lib/db/queries';
import type { CategorySummary } from '@/types';

export const dynamic = 'force-dynamic';

async function getDashboardData() {
  const { year, month } = currentMonthAlmaty();
  try {
    return await getMonthSummary(year, month);
  } catch (e) {
    console.error('Dashboard data fetch error:', e);
    return null;
  }
}

function StatusDot({ percentage }: { percentage: number }) {
  if (percentage >= 100) return <span className="inline-block w-2 h-2 rounded-full bg-red-500" />;
  if (percentage >= 80) return <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />;
}

function ProgressBar({ percentage }: { percentage: number }) {
  const color =
    percentage >= 100
      ? 'bg-gradient-to-r from-red-400 to-red-500'
      : percentage >= 80
        ? 'bg-gradient-to-r from-amber-300 to-amber-400'
        : 'bg-gradient-to-r from-emerald-300 to-emerald-400';

  return (
    <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      />
    </div>
  );
}

function CategoryCard({ item }: { item: CategorySummary }) {
  const { category, planned, actual, remaining, percentage } = item;
  const hasOverflow = remaining < 0;

  return (
    <div className="group relative bg-white rounded-2xl p-4 border border-gray-100 hover:border-gray-200 hover:shadow-md transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">{category.emoji}</span>
          <div>
            <p className="font-semibold text-gray-800 text-sm">{category.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {planned > 0
                ? `${percentage}% от плана`
                : 'Без плана'}
            </p>
          </div>
        </div>
        {planned > 0 && (
          <div className="flex items-center gap-1.5">
            <StatusDot percentage={percentage} />
          </div>
        )}
      </div>

      <div className="flex items-end justify-between mb-2.5">
        <span className="text-xl font-bold text-gray-900 tracking-tight">
          {formatTenge(actual)}
        </span>
        {planned > 0 && (
          <span className="text-xs text-gray-400">
            из {formatTenge(planned)}
          </span>
        )}
      </div>

      {planned > 0 && <ProgressBar percentage={percentage} />}

      {hasOverflow && (
        <p className="text-xs text-red-500 mt-2 font-medium">
          Превышение на {formatTenge(Math.abs(remaining))}
        </p>
      )}
    </div>
  );
}

export default async function Dashboard() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <main className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">🔌</div>
          <h1 className="text-lg font-semibold text-gray-800 mb-2">Нет подключения</h1>
          <p className="text-sm text-gray-500 max-w-xs">
            Настройте SUPABASE_URL и SUPABASE_SERVICE_KEY в переменных окружения Vercel.
          </p>
        </div>
      </main>
    );
  }

  const {
    year, month,
    total_income,
    total_planned, total_actual, total_remaining,
    days_elapsed, days_in_month, categories,
  } = data;

  const activeCats = categories.filter((c: CategorySummary) => c.actual > 0 || c.planned > 0);
  const inactiveCats = categories.filter((c: CategorySummary) => c.actual === 0 && c.planned === 0);
  const dayProgress = Math.round((days_elapsed / days_in_month) * 100);
  const budgetProgress = total_planned > 0 ? Math.round((total_actual / total_planned) * 100) : 0;

  return (
    <main className="min-h-screen bg-[#fafafa]">
      {/* ── Header with gradient ── */}
      <header className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDM0djItSDJ2LTJoMzR6bTAtNHYySDJ2LTJoMzR6Ii8+PC9nPjwvZz48L3N2Zz4=')] opacity-50" />
        <div className="relative max-w-lg mx-auto px-5 pt-6 pb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider font-medium">
                {monthNameRu(month)} {year}
              </p>
              <h1 className="text-xl font-bold mt-0.5">Семейный бюджет</h1>
            </div>
            <div className="text-right">
              <div className="inline-flex items-center gap-1.5 bg-white/10 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                День {days_elapsed}/{days_in_month}
              </div>
            </div>
          </div>

          {/* ── Main stats ── */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-4 border border-white/10">
              <p className="text-xs text-gray-400 mb-1">Потрачено</p>
              <p className="text-2xl font-bold tracking-tight">{formatTenge(total_actual)}</p>
              {total_planned > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  из {formatTenge(total_planned)}
                </p>
              )}
            </div>
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-4 border border-white/10">
              <p className="text-xs text-gray-400 mb-1">
                {total_remaining >= 0 ? 'Остаток' : 'Перерасход'}
              </p>
              <p className={`text-2xl font-bold tracking-tight ${
                total_remaining >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}>
                {formatTenge(Math.abs(total_remaining))}
              </p>
              {total_planned > 0 && (
                <p className="text-xs text-gray-500 mt-1">{budgetProgress}% бюджета</p>
              )}
            </div>
          </div>

          {total_income > 0 && (
            <div className="mt-4 bg-white/5 backdrop-blur-sm rounded-2xl p-4 border border-white/10">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Доход</p>
                  <p className="text-lg font-bold text-emerald-400">{formatTenge(total_income)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-400 mb-1">Баланс</p>
                  <p className={`text-lg font-bold ${
                    total_income - total_actual >= 0 ? 'text-white' : 'text-red-400'
                  }`}>
                    {total_income - total_actual >= 0 ? '+' : ''}{formatTenge(total_income - total_actual)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Budget burn bar ── */}
          {total_planned > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
                <span>Бюджет</span>
                <span>{budgetProgress}%</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    budgetProgress >= 100
                      ? 'bg-gradient-to-r from-red-400 to-red-500'
                      : budgetProgress >= 80
                        ? 'bg-gradient-to-r from-amber-300 to-amber-400'
                        : 'bg-gradient-to-r from-emerald-300 to-emerald-400'
                  }`}
                  style={{ width: `${Math.min(budgetProgress, 100)}%` }}
                />
                {/* Day marker */}
                <div className="relative">
                  <div
                    className="absolute -top-2 w-0.5 h-2 bg-white/30"
                    style={{ left: `${dayProgress}%` }}
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-500 mt-1.5 text-center">
                {budgetProgress > dayProgress
                  ? '⚡ Темп расходов опережает время'
                  : '✨ Расходы в рамках темпа'}
              </p>
            </div>
          )}
        </div>
      </header>

      {/* ── Category grid ── */}
      <div className="max-w-lg mx-auto px-5 -mt-2">
        {activeCats.length > 0 && (
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-1">
              Статьи расходов
            </h2>
            <div className="grid grid-cols-2 gap-2.5">
              {activeCats.map((c: CategorySummary) => (
                <CategoryCard key={c.category.slug} item={c} />
              ))}
            </div>
          </section>
        )}

        {inactiveCats.length > 0 && activeCats.length > 0 && (
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-1">
              Без расходов
            </h2>
            <div className="flex flex-wrap gap-2">
              {inactiveCats.map((c: CategorySummary) => (
                <span
                  key={c.category.slug}
                  className="inline-flex items-center gap-1.5 bg-white rounded-full px-3 py-1.5 text-xs text-gray-400 border border-gray-100"
                >
                  {c.category.emoji} {c.category.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ── Empty state ── */}
        {activeCats.length === 0 && (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">💬</div>
            <h2 className="text-lg font-semibold text-gray-700 mb-2">Начните отслеживать</h2>
            <p className="text-sm text-gray-400 max-w-xs mx-auto leading-relaxed">
              Отправьте расход в Telegram-бот,<br />
              например: <span className="font-medium text-gray-600">кофе 1200</span>
            </p>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className="text-center py-8">
          <p className="text-[10px] text-gray-300">
            Семейный бюджет · {year}
          </p>
        </footer>
      </div>
    </main>
  );
}
