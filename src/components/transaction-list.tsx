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
      <div className="text-center py-20">
        <p className="text-[32px] mb-3">📭</p>
        <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          Нет транзакций за этот месяц
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Summary header */}
      <div className="px-5 mb-4">
        <div className="flex items-baseline gap-2">
          <p className="text-[28px] font-semibold tabular tracking-tight-more" style={{ color: 'var(--text-primary)' }}>
            {formatTenge(totalExpenses)}
          </p>
          {totalIncome > 0 && (
            <p className="text-[14px] font-semibold tabular" style={{ color: 'var(--success)' }}>
              +{formatTenge(totalIncome)}
            </p>
          )}
        </div>
        <p className="text-[11px] uppercase tracking-[0.08em] font-medium mt-0.5" style={{ color: 'var(--text-quaternary)' }}>
          {items.length} {items.length === 1 ? 'запись' : items.length < 5 ? 'записи' : 'записей'}
        </p>
      </div>

      {/* Grouped list */}
      <div className="px-5">
        {Array.from(grouped.entries()).map(([date, txns]) => {
          const dayTotal = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
          return (
            <div key={date} className="mb-5">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-quaternary)' }}>
                  {formatDateLong(date)}
                </span>
                {dayTotal > 0 && (
                  <span className="text-[10px] font-semibold tabular" style={{ color: 'var(--text-quaternary)' }}>
                    {formatTenge(dayTotal)}
                  </span>
                )}
              </div>
              <div
                className="rounded-[10px] overflow-hidden"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {txns.map((tx, idx) => {
                  const isIncome = tx.type === 'income';
                  const isDeleting = deletingId === tx.id;
                  const isLast = idx === txns.length - 1;
                  return (
                    <div
                      key={tx.id}
                      className={`group flex items-center gap-3 px-4 py-3 transition-all ${isDeleting ? 'opacity-40' : ''}`}
                      style={{
                        borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
                      }}
                    >
                      <span className="text-[18px] w-7 text-center flex-shrink-0 leading-none">
                        {isIncome ? '📥' : (tx.category_emoji ?? '❓')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {isIncome ? 'Доход' : (tx.category_name ?? 'Без категории')}
                          {tx.comment && (
                            <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
                              {' '}— {tx.comment}
                            </span>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {tx.user_name && (
                            <span className="text-[10px]" style={{ color: 'var(--text-quaternary)' }}>
                              {tx.user_name}
                            </span>
                          )}
                          <span style={{ color: 'var(--text-quaternary)' }}>·</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-quaternary)' }}>
                            {SOURCE_LABELS[tx.source] ?? tx.source}
                          </span>
                        </div>
                      </div>
                      <span
                        className="text-[13px] font-semibold tabular"
                        style={{ color: isIncome ? 'var(--success)' : 'var(--text-primary)' }}
                      >
                        {isIncome ? '+' : ''}{formatTenge(tx.amount)}
                      </span>
                      <button
                        onClick={() => handleDelete(tx)}
                        disabled={isDeleting}
                        aria-label="Удалить"
                        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-red-50"
                        style={{ color: 'var(--text-quaternary)' }}
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
