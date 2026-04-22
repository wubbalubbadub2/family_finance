// Database row types

export interface User {
  id: string;
  telegram_id: number;
  name: string;
  email: string | null;
  created_at: string;
}

export interface Category {
  id: number;
  family_id: string;
  name: string;
  emoji: string;
  // Slug is any string post-migration 007 (families can create custom categories
  // like "чипсы_снеки"). The CategorySlug union below is the set of DEFAULT
  // slugs seeded for every family — useful for code that relies on canonical
  // defaults (e.g., 'credit' → debt handling, 'misc' → fallback).
  slug: string;
  sort_order: number;
  is_active: boolean;
}

export type CategorySlug =
  | 'home'
  | 'food'
  | 'transport'
  | 'cafe'
  | 'baby'
  | 'health'
  | 'credit'
  | 'personal'
  | 'savings'
  | 'misc';

export type TransactionType = 'expense' | 'income' | 'internal';
export type TransactionSource = 'telegram' | 'web' | 'kaspi_import' | 'recurring';

export interface Transaction {
  id: string;
  user_id: string;
  category_id: number | null;
  type: TransactionType;
  amount: number;
  comment: string | null;
  merchant: string | null;
  source: TransactionSource;
  transaction_date: string;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export interface MonthlyPlan {
  id: string;
  year: number;
  month: number;
  category_id: number | null;
  plan_type: 'expense' | 'income';
  amount: number;
  created_by: string;
  updated_at: string;
}

export interface RecurringTransaction {
  id: string;
  category_id: number;
  type: TransactionType;
  amount: number;
  comment: string;
  day_of_month: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
}

export interface MerchantCategoryMap {
  id: number;
  merchant_pattern: string;
  category_id: number;
  confirmed_by: string | null;
  created_at: string;
}

// Parsed expense from user input
export interface ParsedExpense {
  amount: number;
  category_slug: CategorySlug;
  comment: string | null;
  confidence: number;
}

// Monthly summary for dashboard
export interface CategorySummary {
  category: Category;
  planned: number;
  actual: number;
  remaining: number;
  percentage: number;
}

export interface MonthOverview {
  year: number;
  month: number;
  total_income: number;
  total_planned: number;
  total_actual: number;
  total_remaining: number;
  days_elapsed: number;
  days_in_month: number;
  categories: CategorySummary[];
}
