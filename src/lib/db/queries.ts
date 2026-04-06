import { supabase } from './supabase';
import { currentMonthAlmaty, todayAlmaty, lastDayOfMonth, daysInMonth as daysInMonthUtil } from '@/lib/utils';
import type {
  Transaction,
  User,
  Category,
  MonthlyPlan,
  RecurringTransaction,
  MerchantCategoryMap,
  TransactionType,
  TransactionSource,
} from '@/types';

// ── Users ──

export async function getUserByTelegramId(telegramId: number): Promise<User | null> {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

export async function getUsers(): Promise<User[]> {
  const { data } = await supabase
    .from('users')
    .select('*')
    .order('name');
  return data ?? [];
}

// ── Categories ──

export async function getCategories(): Promise<Category[]> {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  return data ?? [];
}

export async function getCategoryBySlug(slug: string): Promise<Category | null> {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('slug', slug)
    .single();
  return data;
}

// ── Transactions ──

export async function insertTransaction(tx: {
  user_id: string;
  category_id: number | null;
  type: TransactionType;
  amount: number;
  comment?: string;
  merchant?: string;
  source: TransactionSource;
  transaction_date?: string;
}): Promise<Transaction> {
  const { data, error } = await supabase
    .from('transactions')
    .insert(tx)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function softDeleteTransaction(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .select();
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No transaction found with id ${id}`);
}

export async function getLastTransaction(userId: string): Promise<Transaction | null> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

export async function getLastNTransactionsByUser(userId: string, n: number): Promise<Transaction[]> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(n);
  return data ?? [];
}

export async function getLastNTransactionsFamily(n: number): Promise<Transaction[]> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(n);
  return data ?? [];
}

export async function getTransactionsByDateRange(
  startDate: string,
  endDate: string,
  userId?: string
): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*')
    .is('deleted_at', null)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
    .order('transaction_date', { ascending: false });

  if (userId) query = query.eq('user_id', userId);

  const { data } = await query;
  return data ?? [];
}

export async function getMonthTransactions(
  year: number,
  month: number
): Promise<Transaction[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = lastDayOfMonth(year, month);
  return getTransactionsByDateRange(startDate, endDate);
}

// ── Monthly Plans ──

export async function getMonthlyPlans(year: number, month: number): Promise<MonthlyPlan[]> {
  const { data } = await supabase
    .from('monthly_plans')
    .select('*')
    .eq('year', year)
    .eq('month', month);
  return data ?? [];
}

export async function upsertMonthlyPlan(plan: {
  year: number;
  month: number;
  category_id: number | null;
  plan_type: 'expense' | 'income';
  amount: number;
  created_by: string;
}): Promise<MonthlyPlan> {
  const { data, error } = await supabase
    .from('monthly_plans')
    .upsert(plan, { onConflict: 'year,month,category_id,plan_type' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Recurring Transactions ──

export async function getActiveRecurring(): Promise<RecurringTransaction[]> {
  const { data } = await supabase
    .from('recurring_transactions')
    .select('*')
    .eq('is_active', true);
  return data ?? [];
}

export async function insertRecurring(rt: {
  category_id: number;
  type: TransactionType;
  amount: number;
  comment: string;
  day_of_month: number;
  created_by: string;
}): Promise<RecurringTransaction> {
  const { data, error } = await supabase
    .from('recurring_transactions')
    .insert(rt)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Merchant Category Map ──

export async function getMerchantCategory(merchant: string): Promise<MerchantCategoryMap | null> {
  const { data } = await supabase
    .from('merchant_category_map')
    .select('*')
    .eq('merchant_pattern', merchant.toLowerCase())
    .single();
  return data;
}

export async function upsertMerchantCategory(
  merchant: string,
  categoryId: number,
  confirmedBy?: string
): Promise<void> {
  const { error } = await supabase
    .from('merchant_category_map')
    .upsert({
      merchant_pattern: merchant.toLowerCase(),
      category_id: categoryId,
      confirmed_by: confirmedBy,
    }, { onConflict: 'merchant_pattern' });
  if (error) throw error;
}

// ── Debts ──

export interface Debt {
  id: string;
  name: string;
  original_amount: number;
  remaining_amount: number;
  note: string | null;
  created_at: string;
  paid_off_at: string | null;
}

export async function getActiveDebts(): Promise<Debt[]> {
  const { data } = await supabase
    .from('debts')
    .select('*')
    .is('paid_off_at', null)
    .order('remaining_amount', { ascending: false });
  return data ?? [];
}

export async function getAllDebts(): Promise<Debt[]> {
  const { data } = await supabase
    .from('debts')
    .select('*')
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function addDebt(name: string, amount: number, note?: string): Promise<Debt> {
  // Check if debt with same name already exists (active)
  const { data: existing } = await supabase
    .from('debts')
    .select('*')
    .eq('name', name.toLowerCase())
    .is('paid_off_at', null)
    .single();

  if (existing) {
    // Add to existing debt
    const newRemaining = existing.remaining_amount + amount;
    const newOriginal = existing.original_amount + amount;
    const { data, error } = await supabase
      .from('debts')
      .update({ remaining_amount: newRemaining, original_amount: newOriginal })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('debts')
    .insert({
      name: name.toLowerCase(),
      original_amount: amount,
      remaining_amount: amount,
      note,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function payDebt(name: string, amount: number): Promise<Debt | null> {
  const { data: debt } = await supabase
    .from('debts')
    .select('*')
    .eq('name', name.toLowerCase())
    .is('paid_off_at', null)
    .single();

  if (!debt) return null;

  const newRemaining = Math.max(0, debt.remaining_amount - amount);
  const paidOff = newRemaining === 0 ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from('debts')
    .update({ remaining_amount: newRemaining, paid_off_at: paidOff })
    .eq('id', debt.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Conversation Memory ──

export async function getRecentMessages(chatId: number, limit = 10): Promise<{ role: string; content: string }[]> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversation_messages')
    .select('role, content')
    .eq('telegram_chat_id', chatId)
    .gte('created_at', oneHourAgo)
    .order('created_at', { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function saveMessage(chatId: number, role: string, content: string): Promise<void> {
  await supabase.from('conversation_messages').insert({
    telegram_chat_id: chatId,
    role,
    content,
  });
}

// ── Aggregations ──

export async function getMonthSummary(year: number, month: number) {
  const transactions = await getMonthTransactions(year, month);
  const plans = await getMonthlyPlans(year, month);
  const categories = await getCategories();

  const expenses = transactions.filter(t => t.type === 'expense');
  const income = transactions.filter(t => t.type === 'income');

  const categoryTotals = new Map<number, number>();
  for (const tx of expenses) {
    if (tx.category_id) {
      categoryTotals.set(tx.category_id, (categoryTotals.get(tx.category_id) ?? 0) + tx.amount);
    }
  }

  const planMap = new Map<number, number>();
  let incomePlan = 0;
  for (const plan of plans) {
    if (plan.plan_type === 'income') {
      incomePlan += plan.amount;
    } else if (plan.category_id) {
      planMap.set(plan.category_id, plan.amount);
    }
  }

  const categorySummaries = categories.map(cat => {
    const planned = planMap.get(cat.id) ?? 0;
    const actual = categoryTotals.get(cat.id) ?? 0;
    // Only compute remaining for categories WITH a plan
    const remaining = planned > 0 ? planned - actual : 0;
    return {
      category: cat,
      planned,
      actual,
      remaining,
      percentage: planned > 0 ? Math.round((actual / planned) * 100) : 0,
    };
  });

  const totalPlanned = Array.from(planMap.values()).reduce((a, b) => a + b, 0);
  const totalActual = expenses.reduce((a, b) => a + b.amount, 0);
  const totalIncome = income.reduce((a, b) => a + b.amount, 0);

  // Fix: use Almaty timezone for days elapsed (Vercel runs in UTC)
  const { year: almatyYear, month: almatyMonth } = currentMonthAlmaty();
  const almatyDay = parseInt(todayAlmaty().split('-')[2], 10);
  const daysInMonth = daysInMonthUtil(year, month);
  const daysElapsed = year === almatyYear && month === almatyMonth
    ? almatyDay
    : daysInMonth;

  // Spending pace metrics
  const dailyBudget = totalPlanned > 0 && daysInMonth > 0 ? Math.round(totalPlanned / daysInMonth) : 0;
  const dailyActual = daysElapsed > 0 ? Math.round(totalActual / daysElapsed) : 0;
  const daysLeft = daysInMonth - daysElapsed;
  const projectedTotal = daysElapsed > 0 ? Math.round(dailyActual * daysInMonth) : 0;
  const safeDailyRemaining = daysLeft > 0 && totalPlanned > 0
    ? Math.round((totalPlanned - totalActual) / daysLeft)
    : 0;

  return {
    year,
    month,
    total_income: totalIncome,
    total_income_plan: incomePlan,
    total_planned: totalPlanned,
    total_actual: totalActual,
    total_remaining: totalPlanned > 0 ? totalPlanned - totalActual : 0,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    daily_budget: dailyBudget,
    daily_actual: dailyActual,
    projected_total: projectedTotal,
    safe_daily_remaining: safeDailyRemaining,
    categories: categorySummaries,
  };
}
