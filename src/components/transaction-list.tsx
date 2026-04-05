'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatTenge } from '@/lib/utils';

interface TransactionItem {
  id: string;
  amount: number;
  type: string;
  comment: string | null;
  transaction_date: string;
  source: string;
  category_emoji: string | null;
  category_name: string | null;
  user_name: string | null;
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

export default function TransactionList({ items: initialItems }: { items: TransactionItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await fetch('/api/transactions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setItems(prev => prev.filter(t => t.id !== id));
      setSelectedId(null);
      router.refresh();
    } catch (e) {
      console.error('Delete error:', e);
    }
    setDeleting(false);
  };

  // Group by date
  const grouped = new Map<string, TransactionItem[]>();
  for (const tx of items) {
    const date = tx.transaction_date;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(tx);
  }

  const totalExpenses = items.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const totalIncome = items.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);

  if (items.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-4xl mb-3">📭</p>
        <p className="text-sm text-gray-400">Нет транзакций за этот месяц</p>
      </div>
    );
  }

  return (
    <>
      {/* Summary bar */}
      <div className="px-6 pb-4 flex items-center gap-4 text-sm">
        <span className="text-gray-400">{items.length} записей</span>
        <span className="text-gray-300">|</span>
        <span className="font-semibold text-gray-700">{formatTenge(totalExpenses)}</span>
        {totalIncome > 0 && (
          <>
            <span className="text-gray-300">|</span>
            <span className="font-semibold text-emerald-600">+{formatTenge(totalIncome)}</span>
          </>
        )}
      </div>

      {/* Grouped */}
      <div className="px-6">
        {Array.from(grouped.entries()).map(([date, txns]) => {
          const dayTotal = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
          return (
            <div key={date} className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  {formatDateLong(date)}
                </span>
                {dayTotal > 0 && (
                  <span className="text-[11px] font-semibold text-gray-400">{formatTenge(dayTotal)}</span>
                )}
              </div>
              <div className="space-y-0.5">
                {txns.map(tx => {
                  const isIncome = tx.type === 'income';
                  const isSelected = selectedId === tx.id;
                  return (
                    <div key={tx.id}>
                      <button
                        onClick={() => setSelectedId(isSelected ? null : tx.id)}
                        className="w-full flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0 text-left hover:bg-gray-50 transition-colors -mx-2 px-2 rounded-lg"
                      >
                        <span className="text-lg w-7 text-center flex-shrink-0">
                          {isIncome ? '📥' : (tx.category_emoji ?? '❓')}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">
                            {isIncome ? 'Доход' : (tx.category_name ?? 'Без категории')}
                            {tx.comment && <span className="text-gray-400 font-normal"> — {tx.comment}</span>}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {tx.user_name && <span className="text-[10px] text-gray-300">{tx.user_name}</span>}
                            <span className="text-[10px] text-gray-300">{SOURCE_LABELS[tx.source] ?? tx.source}</span>
                          </div>
                        </div>
                        <span className={`text-sm font-semibold tabular-nums ${isIncome ? 'text-emerald-600' : 'text-gray-900'}`}>
                          {isIncome ? '+' : ''}{formatTenge(tx.amount)}
                        </span>
                      </button>

                      {/* Action panel for selected transaction */}
                      {isSelected && (
                        <div className="flex gap-2 py-2 animate-in fade-in slide-in-from-top-1 duration-150">
                          <button
                            onClick={() => handleDelete(tx.id)}
                            disabled={deleting}
                            className="flex-1 py-2 px-3 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors disabled:opacity-50"
                          >
                            {deleting ? 'Удаляю...' : '🗑 Удалить'}
                          </button>
                          <button
                            onClick={() => setSelectedId(null)}
                            className="flex-1 py-2 px-3 rounded-lg bg-gray-100 text-gray-500 text-xs font-medium hover:bg-gray-200 transition-colors"
                          >
                            Отмена
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
