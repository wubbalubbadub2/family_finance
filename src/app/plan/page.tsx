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

interface UserInfo {
  id: string;
  name: string;
}

function PlanForm() {
  const searchParams = useSearchParams();
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(searchParams.get('year') ?? '') || nowYear;
  const month = parseInt(searchParams.get('month') ?? '') || nowMonth;

  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    setSaved(false);
    Promise.all([
      fetch(`/api/plans?year=${year}&month=${month}`).then(r => r.json()),
      fetch('/api/users').then(r => r.json()),
    ]).then(([planData, userData]) => {
      setPlans(planData);
      setUsers(userData);
      if (userData.length > 0) {
        setSelectedUser(prev => prev || userData[0].id);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const total = plans.reduce((s, p) => s + p.amount, 0);

  const updateAmount = (idx: number, value: string) => {
    const num = parseInt(value.replace(/\D/g, ''), 10) || 0;
    setPlans(prev => prev.map((p, i) => i === idx ? { ...p, amount: num } : p));
    setSaved(false);
  };

  const savePlans = async () => {
    if (!selectedUser) return;
    setSaving(true);
    try {
      await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year, month, user_id: selectedUser,
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
    return <div className="flex items-center justify-center py-20 text-gray-400 text-sm">Загрузка...</div>;
  }

  return (
    <>
      {/* User selector */}
      {users.length > 1 && (
        <div className="flex gap-2 mb-5">
          {users.map(u => (
            <button
              key={u.id}
              onClick={() => { setSelectedUser(u.id); setSaved(false); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                selectedUser === u.id
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {u.name}
            </button>
          ))}
        </div>
      )}

      {/* Total */}
      <div className="flex items-center justify-between mb-5 px-1">
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Общий бюджет</span>
        <span className="text-lg font-bold text-gray-900">{formatTenge(total)}</span>
      </div>

      {/* Category inputs */}
      <div className="space-y-2">
        {plans.map((plan, idx) => (
          <div key={plan.slug} className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4">
            <span className="text-2xl w-10 text-center flex-shrink-0">{plan.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800">{plan.name}</p>
            </div>
            <div className="relative">
              <input
                type="text" inputMode="numeric"
                value={plan.amount > 0 ? plan.amount.toLocaleString('ru-RU') : ''}
                onChange={(e) => updateAmount(idx, e.target.value)}
                placeholder="0"
                className="w-28 text-right text-sm font-semibold bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 pr-7 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent transition-all placeholder:text-gray-300"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">₸</span>
            </div>
          </div>
        ))}
      </div>

      {/* Save */}
      <div className="mt-6 sticky bottom-20">
        <button
          onClick={savePlans}
          disabled={saving || !selectedUser}
          className={`w-full py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
            saved ? 'bg-emerald-500 text-white' : 'bg-gray-900 text-white hover:bg-gray-800 active:scale-[0.98]'
          } disabled:opacity-50`}
        >
          {saving ? 'Сохраняю...' : saved ? '✓ Сохранено' : `Сохранить план на ${monthNameRu(month).toLowerCase()}`}
        </button>
      </div>
    </>
  );
}

export default function PlanPage() {
  return (
    <main className="min-h-screen bg-[#fafafa] pb-20">
      <Suspense>
        <MonthPicker />
      </Suspense>
      <div className="max-w-lg mx-auto px-5 pb-6">
        <Suspense fallback={<div className="py-20 text-center text-gray-400 text-sm">Загрузка...</div>}>
          <PlanForm />
        </Suspense>
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
