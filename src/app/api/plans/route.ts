import { NextRequest, NextResponse } from 'next/server';
import { getMonthlyPlans, upsertMonthlyPlan, getCategories } from '@/lib/db/queries';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const year = parseInt(searchParams.get('year') ?? '');
  const month = parseInt(searchParams.get('month') ?? '');

  if (!year || !month) {
    return NextResponse.json({ error: 'year and month required' }, { status: 400 });
  }

  const plans = await getMonthlyPlans(year, month);
  const categories = await getCategories();

  const result = categories.map(cat => {
    const plan = plans.find(p => p.category_id === cat.id && p.plan_type === 'expense');
    return {
      category_id: cat.id,
      slug: cat.slug,
      name: cat.name,
      emoji: cat.emoji,
      amount: plan?.amount ?? 0,
    };
  });

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { year, month, plans, user_id } = body;

  if (!year || !month || !plans || !user_id) {
    return NextResponse.json({ error: 'year, month, plans, user_id required' }, { status: 400 });
  }

  for (const plan of plans) {
    if (plan.amount > 0) {
      await upsertMonthlyPlan({
        year,
        month,
        category_id: plan.category_id,
        plan_type: 'expense',
        amount: plan.amount,
        created_by: user_id,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
