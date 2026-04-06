'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatTenge } from '@/lib/utils';

interface DebtItem {
  id: string;
  name: string;
  original_amount: number;
  remaining_amount: number;
}

export default function DebtList({ initialDebts }: { initialDebts: DebtItem[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [debts, setDebts] = useState(initialDebts);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (d: DebtItem) => {
    if (deletingId) return;
    const label = d.name.charAt(0).toUpperCase() + d.name.slice(1);
    if (!confirm(`Удалить долг "${label}" (${formatTenge(d.remaining_amount)})?`)) return;

    setDeletingId(d.id);
    try {
      const res = await fetch('/api/debts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      });
      if (!res.ok) throw new Error('Failed');
      setDebts(prev => prev.filter(x => x.id !== d.id));
      startTransition(() => router.refresh());
    } catch {
      alert('Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      {debts.map((d, idx) => {
        const dPaid = d.original_amount - d.remaining_amount;
        const dPct = d.original_amount > 0 ? Math.round((dPaid / d.original_amount) * 100) : 0;
        const isDeleting = deletingId === d.id;
        return (
          <div
            key={d.id}
            className={`px-6 py-4 transition-all ${isDeleting ? 'opacity-40' : ''}`}
            style={{ borderBottom: idx === debts.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[14px] font-medium" style={{ color: 'var(--ink-1)' }}>
                {d.name.charAt(0).toUpperCase() + d.name.slice(1)}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[14px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                  {formatTenge(d.remaining_amount)}
                </span>
                <button
                  onClick={() => handleDelete(d)}
                  disabled={isDeleting}
                  aria-label="Удалить"
                  className="w-6 h-6 flex items-center justify-center rounded-full transition-colors hover:bg-red-50"
                  style={{ color: 'var(--ink-4)' }}
                >
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                    <path d="M2 4h10M5 4V2.5A.5.5 0 0 1 5.5 2h3a.5.5 0 0 1 .5.5V4m1.5 0v7.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5V4h6zM6 6.5v4M8 6.5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            <div className="w-full h-[3px] overflow-hidden" style={{ backgroundColor: 'var(--ink-6)' }}>
              <div className="h-full transition-all duration-700" style={{ width: `${dPct}%`, backgroundColor: 'var(--green)' }} />
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                выплачено {formatTenge(dPaid)}
              </span>
              <span className="text-[11px] font-medium tabular" style={{ color: dPct > 0 ? 'var(--green)' : 'var(--ink-4)' }}>
                {dPct}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
