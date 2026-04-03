-- Family Budget Tracker: Initial Schema
-- All amounts are stored as integers (whole tenge)

-- Users (whitelist of family members)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint UNIQUE NOT NULL,
  name text NOT NULL,
  email text,
  created_at timestamptz DEFAULT now()
);

-- Expense categories (10 fixed categories)
CREATE TABLE categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  emoji text NOT NULL,
  slug text UNIQUE NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

-- Merchant-to-category cache (avoids re-asking Claude for known merchants)
CREATE TABLE merchant_category_map (
  id serial PRIMARY KEY,
  merchant_pattern text UNIQUE NOT NULL,
  category_id int NOT NULL REFERENCES categories(id),
  confirmed_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

-- Monthly budget plans (expense + income)
CREATE TABLE monthly_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_id int REFERENCES categories(id),
  plan_type text NOT NULL DEFAULT 'expense' CHECK (plan_type IN ('expense', 'income')),
  amount int NOT NULL CHECK (amount >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(year, month, category_id, plan_type)
);

-- Transactions (expenses, income, internal transfers)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  category_id int REFERENCES categories(id),
  type text NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'income', 'internal')),
  amount int NOT NULL CHECK (amount > 0),
  comment text,
  merchant text,
  source text NOT NULL DEFAULT 'telegram' CHECK (source IN ('telegram', 'web', 'kaspi_import', 'recurring')),
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX idx_txn_date ON transactions(transaction_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_txn_user_date ON transactions(user_id, transaction_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_txn_cat_date ON transactions(category_id, transaction_date) WHERE deleted_at IS NULL;

-- Recurring transactions (credits, salary, etc.)
CREATE TABLE recurring_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id int NOT NULL REFERENCES categories(id),
  type text NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'income')),
  amount int NOT NULL CHECK (amount > 0),
  comment text NOT NULL,
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

-- Seed categories
INSERT INTO categories (name, emoji, slug, sort_order) VALUES
  ('Жильё',           '🏠', 'home',      1),
  ('Продукты',        '🛒', 'food',      2),
  ('Транспорт',       '🚗', 'transport', 3),
  ('Кафе & выход',    '☕', 'cafe',      4),
  ('Балапанчик',      '👶', 'baby',      5),
  ('Здоровье',        '💊', 'health',    6),
  ('Кредиты',         '💳', 'credit',    7),
  ('Личное',          '🎯', 'personal',  8),
  ('Savings',         '💰', 'savings',   9),
  ('Разное',          '🎲', 'misc',     10);
