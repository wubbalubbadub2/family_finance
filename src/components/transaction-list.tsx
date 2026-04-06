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
    } finally {
      setDeletingId(null);
    }
  };

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
      <div className="text-center py-24 px-8">
        <p className="text-[32px] mb-4">📭</p>
        <p className="text-[14px]" style={{ color: 'var(--ink-3)' }}>
          Нет транзакций за этот месяц
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Compact summary */}
      <header className="px-6 pt-1 pb-5">
        <div className="flex items-end justify-between">
          <div>
            <p className="label-sm mb-1">
              {items.length} {items.length === 1 ? 'запись' : items.length < 5 ? 'записи' : 'записей'}
            </p>
            <h1 className="display text-[36px]" style={{ color: 'var(--ink-1)' }}>
              {formatTenge(totalExpenses)}
            </h1>
          </div>
          {totalIncome > 0 && (
            <p className="text-[14px] font-semibold tabular pb-0.5" style={{ color: 'var(--green)' }}>
              +{formatTenge(totalIncome)}
            </p>
          )}
        </div>
      </header>

      {/* Grouped list */}
      <div>
        {Array.from(grouped.entries()).map(([date, txns]) => {
          const dayTotal = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
          return (
            <div key={date}>
              <div
                className="flex items-center justify-between px-6 py-3"
                style={{
                  backgroundColor: 'var(--bg-alt)',
                }}
              >
                <span className="label-sm">{formatDateLong(date)}</span>
                {dayTotal > 0 && (
                  <span className="text-[11px] font-semibold tabular" style={{ color: 'var(--ink-3)' }}>
                    {formatTenge(dayTotal)}
                  </span>
                )}
              </div>
              <div>
                {txns.map((tx, idx) => {
                  const isIncome = tx.type === 'income';
                  const isDeleting = deletingId === tx.id;
                  return (
                    <div
                      key={tx.id}
                      className={`group flex items-center gap-4 px-6 py-4 transition-all ${isDeleting ? 'opacity-40' : ''}`}
                      style={{
                        borderBottom: idx === txns.length - 1 ? 'none' : '1px solid var(--ink-6)',
                      }}
                    >
                      <span className="text-[20px] leading-none flex-shrink-0 w-7 text-center">
                        {isIncome ? '📥' : (tx.category_emoji ?? '❓')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium truncate" style={{ color: 'var(--ink-2)' }}>
                          {isIncome ? 'Доход' : (tx.category_name ?? 'Без категории')}
                          {tx.comment && (
                            <span className="font-normal" style={{ color: 'var(--ink-3)' }}>
                              {' '}— {tx.comment}
                            </span>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {tx.user_name && (
                            <span className="text-[10px]" style={{ color: 'var(--ink-4)' }}>
                              {tx.user_name}
                            </span>
                          )}
                          <span style={{ color: 'var(--ink-5)' }}>·</span>
                          <span className="text-[10px]" style={{ color: 'var(--ink-4)' }}>
                            {SOURCE_LABELS[tx.source] ?? tx.source}
                          </span>
                        </div>
                      </div>
                      <span
                        className="text-[14px] font-semibold tabular"
                        style={{ color: isIncome ? 'var(--green)' : 'var(--ink-1)' }}
                      >
                        {isIncome ? '+' : ''}{formatTenge(tx.amount)}
                      </span>
                      <button
                        onClick={() => handleDelete(tx)}
                        disabled={isDeleting}
                        aria-label="Удалить"
                        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-red-50"
                        style={{ color: 'var(--ink-4)' }}
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
