'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatTenge, currentMonthAlmaty } from '@/lib/utils';
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
      .then(data => { setPlans(data); setLoading(false); })
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
      <div className="py-24 text-center text-[13px]" style={{ color: 'var(--ink-4)' }}>
        Загрузка...
      </div>
    );
  }

  return (
    <>
      {/* Hero: total + label */}
      <header className="px-6 pt-2 pb-6">
        <div className="flex items-end justify-between">
          <div>
            <p className="overline mb-1">Бюджет</p>
            <h1 className="display text-[36px]" style={{ color: 'var(--ink-1)' }}>
              {formatTenge(total)}
            </h1>
          </div>
        </div>
      </header>

      {/* Category list — no cards, clean dividers */}
      <div className="border-t" style={{ borderColor: 'var(--ink-6)' }}>
        {plans.map((plan, idx) => (
          <label
            key={plan.slug}
            className="flex items-center gap-4 px-6 py-4 cursor-text transition-colors hover:bg-[--bg-alt]"
            style={{
              borderBottom: idx === plans.length - 1 ? 'none' : '1px solid var(--ink-6)',
            }}
          >
            <span className="text-[22px] leading-none flex-shrink-0 w-7 text-center">
              {plan.emoji}
            </span>
            <span
              className="flex-1 text-[15px] font-medium"
              style={{ color: 'var(--ink-2)' }}
            >
              {plan.name}
            </span>
            <div className="relative flex items-baseline">
              <input
                type="text"
                inputMode="numeric"
                value={plan.amount > 0 ? plan.amount.toLocaleString('ru-RU') : ''}
                onChange={(e) => updateAmount(idx, e.target.value)}
                placeholder="0"
                className="w-[120px] text-right text-[17px] font-semibold tabular bg-transparent border-0 focus:outline-none focus:ring-0 placeholder:text-[--ink-5]"
                style={{ color: 'var(--ink-1)' }}
              />
              <span
                className="text-[13px] ml-1"
                style={{ color: 'var(--ink-4)' }}
              >
                ₸
              </span>
            </div>
          </label>
        ))}
      </div>

      {/* Bottom spacer for floating button */}
      <div className="h-24" />

      {/* Floating save button — fixed above the nav bar */}
      <div
        className="fixed left-0 right-0 z-40 pointer-events-none"
        style={{ bottom: '72px' }}
      >
        <div className="max-w-lg mx-auto px-6 pb-3 pt-6 pointer-events-auto"
          style={{
            background: 'linear-gradient(to top, var(--bg) 40%, transparent)',
          }}
        >
          <button
            onClick={savePlans}
            disabled={saving}
            className="w-full py-4 rounded-full text-[14px] font-semibold transition-all active:scale-[0.98] disabled:opacity-40"
            style={{
              backgroundColor: saved ? 'var(--green)' : 'var(--ink-1)',
              color: '#ffffff',
            }}
          >
            {saving ? 'Сохраняю...' : saved ? 'Сохранено ✓' : 'Сохранить план'}
          </button>
        </div>
      </div>
    </>
  );
}

export default function PlanPage() {
  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">
        <Suspense>
          <MonthPicker />
        </Suspense>
        <Suspense
          fallback={
            <div className="py-24 text-center text-[13px]" style={{ color: 'var(--ink-4)' }}>
              Загрузка...
            </div>
          }
        >
          <PlanForm />
        </Suspense>
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
