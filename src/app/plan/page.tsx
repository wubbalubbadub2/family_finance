import { Suspense } from 'react';
import { currentMonthAlmaty, formatTenge } from '@/lib/utils';
import { getMonthlyPlans, getCategories } from '@/lib/db/queries';
import MonthPicker from '@/components/month-picker';
import Nav from '@/components/nav';
import PlanForm from '@/components/plan-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

export default async function PlanPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();
  const year = parseInt(params.year ?? '') || nowYear;
  const month = parseInt(params.month ?? '') || nowMonth;

  const [plans, categories] = await Promise.all([
    getMonthlyPlans(year, month),
    getCategories(),
  ]);

  const items = categories.map(cat => {
    const plan = plans.find(p => p.category_id === cat.id && p.plan_type === 'expense');
    return {
      category_id: cat.id,
      slug: cat.slug,
      name: cat.name,
      emoji: cat.emoji,
      amount: plan?.amount ?? 0,
    };
  });

  const total = items.reduce((s, p) => s + p.amount, 0);

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">
        <Suspense><MonthPicker /></Suspense>

        <header className="px-6 pt-2 pb-6">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-sm mb-1">Бюджет</p>
              <h1 className="display text-[36px]" style={{ color: 'var(--ink-1)' }}>
                {formatTenge(total)}
              </h1>
            </div>
          </div>
        </header>

        <PlanForm initialPlans={items} year={year} month={month} />
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
