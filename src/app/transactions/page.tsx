import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { getMonthTransactions, getCategories, getUsers } from '@/lib/db/queries';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

const SOURCE_LABELS: Record<string, string> = {
  telegram: 'бот',
  web: 'сайт',
  kaspi_import: 'Kaspi',
  recurring: 'авто',
};

function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  return `${d.getDate()} ${months[d.getMonth()]}, ${days[d.getDay()]}`;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(params.year ?? '') || nowYear;
  const month = parseInt(params.month ?? '') || nowMonth;

  const [transactions, categories, users] = await Promise.all([
    getMonthTransactions(year, month),
    getCategories(),
    getUsers(),
  ]);

  const catMap = new Map(categories.map(c => [c.id, c]));
  const userMap = new Map(users.map(u => [u.id, u]));

  // Filter visible transactions and group by date
  const visible = transactions
    .filter(t => !t.deleted_at && t.type !== 'internal')
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date) || b.created_at.localeCompare(a.created_at));

  const grouped = new Map<string, typeof visible>();
  for (const tx of visible) {
    const date = tx.transaction_date;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(tx);
  }

  const totalExpenses = visible.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const totalIncome = visible.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);

  return (
    <main className="min-h-screen bg-white pb-20">
      <div className="max-w-lg mx-auto">
        <Suspense><MonthPicker /></Suspense>

        {/* Summary bar */}
        <div className="px-6 pb-4 flex items-center gap-4 text-sm">
          <span className="text-gray-400">{visible.length} записей</span>
          <span className="text-gray-300">|</span>
          <span className="font-semibold text-gray-700">{formatTenge(totalExpenses)}</span>
          {totalIncome > 0 && (
            <>
              <span className="text-gray-300">|</span>
              <span className="font-semibold text-emerald-600">+{formatTenge(totalIncome)}</span>
            </>
          )}
        </div>

        {/* Grouped transactions */}
        {visible.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">📭</p>
            <p className="text-sm text-gray-400">Нет транзакций за этот месяц</p>
          </div>
        ) : (
          <div className="px-6">
            {Array.from(grouped.entries()).map(([date, txns]) => {
              const dayTotal = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
              return (
                <div key={date} className="mb-5">
                  {/* Date header */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      {formatDateLong(date)}
                    </span>
                    {dayTotal > 0 && (
                      <span className="text-[11px] font-semibold text-gray-400">{formatTenge(dayTotal)}</span>
                    )}
                  </div>
                  {/* Transaction rows */}
                  <div className="space-y-0.5">
                    {txns.map(tx => {
                      const cat = tx.category_id ? catMap.get(tx.category_id) : null;
                      const user = userMap.get(tx.user_id);
                      const isIncome = tx.type === 'income';
                      return (
                        <div key={tx.id} className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
                          <span className="text-lg w-7 text-center flex-shrink-0">
                            {isIncome ? '📥' : (cat?.emoji ?? '❓')}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {isIncome ? 'Доход' : (cat?.name ?? 'Без категории')}
                              {tx.comment && <span className="text-gray-400 font-normal"> — {tx.comment}</span>}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {user && <span className="text-[10px] text-gray-300">{user.name}</span>}
                              <span className="text-[10px] text-gray-300">{SOURCE_LABELS[tx.source] ?? tx.source}</span>
                            </div>
                          </div>
                          <span className={`text-sm font-semibold tabular-nums ${isIncome ? 'text-emerald-600' : 'text-gray-900'}`}>
                            {isIncome ? '+' : ''}{formatTenge(tx.amount)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
