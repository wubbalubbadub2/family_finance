'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatTenge, currentMonthAlmaty, monthNameRu } from '@/lib/utils';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';

interface PlanItem {
  category_id: number;
  slug: string;
  name: string;
  emoji: string;
  amount: number;
}

function PlanForm() {
  const searchParams = useSearchParams();
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(searchParams.get('year') ?? '') || nowYear;
  const month = parseInt(searchParams.get('month') ?? '') || nowMonth;

  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    setSaved(false);
    fetch(`/api/plans?year=${year}&month=${month}`)
      .then(r => r.json())
      .then(data => {
        setPlans(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [year, month]);

  const total = plans.reduce((s, p) => s + p.amount, 0);

  const updateAmount = (idx: number, value: string) => {
    const num = parseInt(value.replace(/\D/g, ''), 10) || 0;
    setPlans(prev => prev.map((p, i) => i === idx ? { ...p, amount: num } : p));
    setSaved(false);
  };

  const savePlans = async () => {
    setSaving(true);
    try {
      await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year, month,
          plans: plans.map(p => ({ category_id: p.category_id, amount: p.amount })),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error('Save error:', e);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[13px] text-[--text-quaternary]" style={{ color: 'var(--text-quaternary)' }}>
          Загрузка...
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Total */}
      <div className="flex items-end justify-between mb-6 px-1">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--text-quaternary)' }}>
            Бюджет на {monthNameRu(month).toLowerCase()}
          </p>
          <p className="text-[28px] font-semibold mt-0.5 tabular tracking-tight-more" style={{ color: 'var(--text-primary)' }}>
            {formatTenge(total)}
          </p>
        </div>
      </div>

      {/* Category inputs */}
      <div className="space-y-1.5">
        {plans.map((plan, idx) => (
          <div
            key={plan.slug}
            className="flex items-center gap-3 rounded-[10px] px-4 py-3.5 transition-colors"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <span className="text-[22px] w-9 text-center flex-shrink-0 leading-none">{plan.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {plan.name}
              </p>
            </div>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={plan.amount > 0 ? plan.amount.toLocaleString('ru-RU') : ''}
                onChange={(e) => updateAmount(idx, e.target.value)}
                placeholder="0"
                className="w-[110px] text-right text-[14px] font-semibold tabular rounded-[8px] px-3 py-2 pr-7 focus:outline-none transition-all"
                style={{
                  backgroundColor: 'var(--bg-muted)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
              />
              <span
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] pointer-events-none"
                style={{ color: 'var(--text-quaternary)' }}
              >
                ₸
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Save button */}
      <div className="sticky bottom-[88px] mt-6 pb-2 bg-gradient-to-t" style={{
        background: `linear-gradient(to top, var(--bg-base) 60%, transparent)`,
      }}>
        <button
          onClick={savePlans}
          disabled={saving}
          className="w-full py-3.5 rounded-[10px] text-[14px] font-semibold transition-all duration-200 active:scale-[0.98] disabled:opacity-40"
          style={{
            backgroundColor: saved ? 'var(--success)' : 'var(--accent)',
            color: '#ffffff',
          }}
        >
          {saving ? 'Сохраняю...' : saved ? '✓ Сохранено' : 'Сохранить план'}
        </button>
      </div>
    </>
  );
}

export default function PlanPage() {
  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg-base)' }}>
      <div className="max-w-lg mx-auto">
        <Suspense>
          <MonthPicker />
        </Suspense>
        <div className="px-5 pb-6">
          <Suspense fallback={<div className="py-20 text-center text-[13px]" style={{ color: 'var(--text-quaternary)' }}>Загрузка...</div>}>
            <PlanForm />
          </Suspense>
        </div>
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
