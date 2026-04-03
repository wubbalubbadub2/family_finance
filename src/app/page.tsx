import { currentMonthAlmaty, formatTenge, monthNameRu } from '@/lib/utils';
import { getMonthSummary } from '@/lib/db/queries';
import type { CategorySummary } from '@/types';

// Query Supabase directly in the server component
async function getDashboardData() {
  const { year, month } = currentMonthAlmaty();
  try {
    return await getMonthSummary(year, month);
  } catch (e) {
    console.error('Dashboard data fetch error:', e);
    return null;
  }
}

function ProgressBar({ percentage }: { percentage: number }) {
  const color =
    percentage >= 100 ? 'bg-red-500' :
    percentage >= 80 ? 'bg-yellow-500' :
    'bg-green-500';

  return (
    <div className="w-full bg-gray-200 rounded-full h-2">
      <div
        className={`h-2 rounded-full ${color}`}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      />
    </div>
  );
}

export default async function Dashboard() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <main className="min-h-screen bg-gray-50 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-bold mb-4">Семейный бюджет</h1>
          <p className="text-gray-500">
            Настройте переменные окружения (SUPABASE_URL, SUPABASE_SERVICE_KEY) для подключения к базе данных.
          </p>
        </div>
      </main>
    );
  }

  const { year, month, total_income, total_planned, total_actual, total_remaining, days_elapsed, days_in_month, categories } = data;

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-4 sm:px-8">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold">💰 Семейный бюджет</h1>
          <span className="text-sm text-gray-500">
            {monthNameRu(month)} {year}
          </span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 sm:p-8 space-y-6">
        {/* Month overview card */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Обзор месяца</h2>
            <span className="text-sm text-gray-400">
              День {days_elapsed} из {days_in_month}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            {total_income > 0 && (
              <div>
                <p className="text-xs text-gray-500 uppercase">Доход</p>
                <p className="text-lg font-bold text-green-600">{formatTenge(total_income)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 uppercase">Расходы</p>
              <p className="text-lg font-bold">{formatTenge(total_actual)}</p>
            </div>
            {total_planned > 0 && (
              <div>
                <p className="text-xs text-gray-500 uppercase">План</p>
                <p className="text-lg font-bold text-gray-400">{formatTenge(total_planned)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 uppercase">Остаток</p>
              <p className={`text-lg font-bold ${total_remaining >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {formatTenge(Math.abs(total_remaining))}
              </p>
            </div>
          </div>

          {total_planned > 0 && (
            <ProgressBar percentage={Math.round((total_actual / total_planned) * 100)} />
          )}
        </div>

        {/* Category cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {categories
            .filter((c: CategorySummary) => c.actual > 0 || c.planned > 0)
            .map((c: CategorySummary) => (
              <div key={c.category.slug} className="bg-white rounded-xl shadow-sm border p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">
                    {c.category.emoji} {c.category.name}
                  </span>
                  {c.planned > 0 && (
                    <span className={`text-sm font-mono ${
                      c.percentage >= 100 ? 'text-red-500' :
                      c.percentage >= 80 ? 'text-yellow-600' :
                      'text-green-600'
                    }`}>
                      {c.percentage}%
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-sm text-gray-500 mb-2">
                  <span>{formatTenge(c.actual)}</span>
                  {c.planned > 0 && <span>из {formatTenge(c.planned)}</span>}
                </div>
                {c.planned > 0 && <ProgressBar percentage={c.percentage} />}
              </div>
            ))}
        </div>

        {/* Empty state */}
        {categories.every((c: CategorySummary) => c.actual === 0 && c.planned === 0) && (
          <div className="text-center py-12 text-gray-400">
            <p className="text-4xl mb-4">📭</p>
            <p>Пока нет данных за этот месяц.</p>
            <p className="text-sm mt-2">Отправьте расход в Telegram-бот, чтобы начать.</p>
          </div>
        )}
      </div>
    </main>
  );
}
