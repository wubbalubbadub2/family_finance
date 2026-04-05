'use client';

import { useState, useTransition } from 'react';
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
  const [, startTransition] = useTransition();
  const [items, setItems] = useState(initialItems);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (tx: TransactionItem) => {
    if (deletingId) return;

    const label = tx.category_name ? `${tx.category_emoji} ${tx.category_name}` : 'эту запись';
    if (!confirm(`Удалить ${label} — ${formatTenge(tx.amount)}?`)) return;

    setDeletingId(tx.id);
    try {
      const res = await fetch('/api/transactions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tx.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setItems(prev => prev.filter(t => t.id !== tx.id));
      startTransition(() => router.refresh());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Ошибка удаления: ${msg}`);
      setDeletingId(null);
    }
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
                  const isDeleting = deletingId === tx.id;
                  return (
                    <div
                      key={tx.id}
                      className={`group flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0 transition-all ${
                        isDeleting ? 'opacity-40' : ''
                      }`}
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
                      <button
                        onClick={() => handleDelete(tx)}
                        disabled={isDeleting}
                        aria-label="Удалить"
                        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path d="M2 4h10M5 4V2.5A.5.5 0 0 1 5.5 2h3a.5.5 0 0 1 .5.5V4m1.5 0v7.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5V4h6zM6 6.5v4M8 6.5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
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
