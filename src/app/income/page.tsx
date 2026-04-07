import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { getMonthTransactions, getUsers } from '@/lib/db/queries';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';


export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

export default async function IncomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(params.year ?? '') || nowYear;
  const month = parseInt(params.month ?? '') || nowMonth;

  const [transactions, users] = await Promise.all([
    getMonthTransactions(year, month),
    getUsers(),
  ]);

  const userMap = new Map(users.map(u => [u.id, u]));
  const incomeItems = transactions
    .filter(t => t.type === 'income' && !t.deleted_at)
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));

  const total = incomeItems.reduce((s, t) => s + t.amount, 0);

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">

        <Suspense><MonthPicker /></Suspense>

        <header className="px-6 pt-1 pb-6">
          <p className="label-sm mb-1">Доходы</p>
          <h1 className="display text-[36px]" style={{ color: total > 0 ? 'var(--green)' : 'var(--ink-1)' }}>
            {formatTenge(total)}
          </h1>
        </header>

        {incomeItems.length === 0 ? (
          <div className="text-center py-16 px-8">
            <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>
              Нет доходов за этот месяц
            </p>
            <p className="text-[13px] mt-2" style={{ color: 'var(--ink-4)' }}>
              Напишите в бот: <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>зарплата 500000</span>
            </p>
          </div>
        ) : (
          <div>
            {incomeItems.map((tx, idx) => {
              const user = userMap.get(tx.user_id);
              return (
                <div
                  key={tx.id}
                  className="flex items-center gap-4 px-6 py-3.5"
                  style={{ borderBottom: idx === incomeItems.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
                >
                  <span className="text-[18px] leading-none flex-shrink-0">📥</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium" style={{ color: 'var(--ink-2)' }}>
                      {tx.comment || 'Доход'}
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
                      {formatDateShort(tx.transaction_date)}
                      {user && ` · ${user.name}`}
                    </p>
                  </div>
                  <span className="text-[14px] font-semibold tabular" style={{ color: 'var(--green)' }}>
                    +{formatTenge(tx.amount)}
                  </span>
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
