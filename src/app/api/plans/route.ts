import { NextRequest, NextResponse } from 'next/server';
import { getMonthlyPlans, upsertMonthlyPlan, getCategoriesForFamily, getUsersInFamily } from '@/lib/db/queries';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const year = parseInt(searchParams.get('year') ?? '');
  const month = parseInt(searchParams.get('month') ?? '');

  if (!year || !month) {
    return NextResponse.json({ error: 'year and month required' }, { status: 400 });
  }

  const plans = await getMonthlyPlans(year, month, DEFAULT_FAMILY_ID);
  const categories = await getCategoriesForFamily(DEFAULT_FAMILY_ID);

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
  const { year, month, plans } = body;

  if (!year || !month || !plans) {
    return NextResponse.json({ error: 'year, month, plans required' }, { status: 400 });
  }

  // The family plan is shared — created_by is just for audit trail.
  // Use the first user from the DB as the owner.
  const users = await getUsersInFamily(DEFAULT_FAMILY_ID);
  if (users.length === 0) {
    return NextResponse.json({ error: 'No users in family' }, { status: 500 });
  }
  const createdBy = users[0].id;

  for (const plan of plans) {
    if (plan.amount > 0) {
      await upsertMonthlyPlan({
        family_id: DEFAULT_FAMILY_ID,
        year,
        month,
        category_id: plan.category_id,
        plan_type: 'expense',
        amount: plan.amount,
        created_by: createdBy,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
