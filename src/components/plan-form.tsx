'use client';

import { useState } from 'react';
// formatTenge used by parent page for the header total

interface PlanItem {
  category_id: number;
  slug: string;
  name: string;
  emoji: string;
  amount: number;
}

export default function PlanForm({
  initialPlans,
  year,
  month,
}: {
  initialPlans: PlanItem[];
  year: number;
  month: number;
}) {
  const [plans, setPlans] = useState(initialPlans);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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

  return (
    <>
      <div>
        {plans.map((plan, idx) => (
          <label
            key={plan.slug}
            className="flex items-center gap-4 px-6 py-4 cursor-text transition-colors hover:bg-[--bg-alt]"
            style={{ borderBottom: idx === plans.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
          >
            <span className="text-[22px] leading-none flex-shrink-0 w-7 text-center">{plan.emoji}</span>
            <span className="flex-1 text-[15px] font-medium" style={{ color: 'var(--ink-2)' }}>
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
              <span className="text-[13px] ml-1" style={{ color: 'var(--ink-4)' }}>₸</span>
            </div>
          </label>
        ))}
      </div>

      <div className="h-24" />

      <div className="fixed left-0 right-0 z-40 pointer-events-none" style={{ bottom: '72px' }}>
        <div
          className="max-w-lg mx-auto px-6 pb-3 pt-6 pointer-events-auto"
          style={{ background: 'linear-gradient(to top, var(--bg) 40%, transparent)' }}
        >
          <button
            onClick={savePlans}
            disabled={saving}
            className="w-full py-4 rounded-full text-[14px] font-semibold transition-all active:scale-[0.98] disabled:opacity-40"
            style={{ backgroundColor: saved ? 'var(--green)' : 'var(--ink-1)', color: '#ffffff' }}
          >
            {saving ? 'Сохраняю...' : saved ? 'Сохранено ✓' : 'Сохранить план'}
          </button>
        </div>
      </div>
    </>
  );
}
