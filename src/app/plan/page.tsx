'use client';

import { useState, useEffect } from 'react';
import { formatTenge, currentMonthAlmaty, monthNameRu } from '@/lib/utils';

interface PlanItem {
  category_id: number;
  slug: string;
  name: string;
  emoji: string;
  amount: number;
}

export default function PlanPage() {
  const { year, month } = currentMonthAlmaty();
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
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
          year,
          month,
          // TODO: pass actual user_id from auth — for now use a placeholder
          user_id: '00000000-0000-0000-0000-000000000000',
          plans: plans.map(p => ({ category_id: p.category_id, amount: p.amount })),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error('Save error:', e);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="animate-pulse text-gray-400">Загрузка...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#fafafa]">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-5 py-4 flex items-center justify-between">
          <div>
            <a href="/" className="text-xs text-gray-400 hover:text-gray-600">&larr; Дашборд</a>
            <h1 className="text-lg font-bold text-gray-900 mt-0.5">
              План на {monthNameRu(month).toLowerCase()}
            </h1>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">Общий бюджет</p>
            <p className="text-lg font-bold text-gray-900">{formatTenge(total)}</p>
          </div>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-5 py-6">
        {/* Category inputs */}
        <div className="space-y-2">
          {plans.map((plan, idx) => (
            <div
              key={plan.slug}
              className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4"
            >
              <span className="text-2xl w-10 text-center flex-shrink-0">{plan.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">{plan.name}</p>
              </div>
              <div className="relative">
                <input
                  type="text"
                  inputMode="numeric"
                  value={plan.amount > 0 ? plan.amount.toLocaleString('ru-RU') : ''}
                  onChange={(e) => updateAmount(idx, e.target.value)}
                  placeholder="0"
                  className="w-32 text-right text-sm font-semibold bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent transition-all placeholder:text-gray-300"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                  ₸
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Save button */}
        <div className="mt-6 sticky bottom-6">
          <button
            onClick={savePlans}
            disabled={saving}
            className={`w-full py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
              saved
                ? 'bg-emerald-500 text-white'
                : 'bg-gray-900 text-white hover:bg-gray-800 active:scale-[0.98]'
            } disabled:opacity-50`}
          >
            {saving ? 'Сохраняю...' : saved ? '✓ Сохранено' : 'Сохранить план'}
          </button>
        </div>
      </div>
    </main>
  );
}
