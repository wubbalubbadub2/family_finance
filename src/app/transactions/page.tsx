import { Suspense } from 'react';
import { currentMonthAlmaty } from '@/lib/utils';
import { getMonthTransactions, getCategories, getUsers } from '@/lib/db/queries';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';
import TransactionList from '@/components/transaction-list';


export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
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

  const visible = transactions
    .filter(t => !t.deleted_at && t.type !== 'internal')
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date) || b.created_at.localeCompare(a.created_at));

  const items = visible.map(tx => {
    const cat = tx.category_id ? categories.find(c => c.id === tx.category_id) : null;
    const user = users.find(u => u.id === tx.user_id);
    return {
      id: tx.id,
      amount: tx.amount,
      type: tx.type,
      comment: tx.comment,
      transaction_date: tx.transaction_date,
      source: tx.source,
      category_emoji: cat?.emoji ?? null,
      category_name: cat?.name ?? null,
      user_name: user?.name ?? null,
    };
  });

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">

        <Suspense><MonthPicker /></Suspense>
        <TransactionList items={items} />
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
