-- 005: Multi-tenancy refactor
-- Adds `families` table and `family_id` to every family-scoped table.
-- Idempotent: safe to re-run. Uses a fixed UUID for the default (Shynggys) family
-- so backfill is deterministic.

-- ─────────────────────────────────────────────────────────────────────────────
-- Families table
-- `primary_chat_id` is the Telegram chat the bot posts cron notifications to
-- (nullable for v1 — populated manually per family when onboarded).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  primary_chat_id bigint,
  created_at timestamptz DEFAULT now()
);

-- Default family for existing single-tenant data.
-- Fixed UUID so backfill is deterministic across environments.
INSERT INTO families (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Shynggys Family')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Add family_id columns (nullable at first for safe backfill)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users                   ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
ALTER TABLE transactions            ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
ALTER TABLE monthly_plans           ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
ALTER TABLE recurring_transactions  ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
ALTER TABLE debts                   ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
ALTER TABLE conversation_messages   ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);
-- merchant_category_map.family_id stays nullable: null = global cache, non-null = per-family override
ALTER TABLE merchant_category_map   ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill existing rows to the default family
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE users                  SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
UPDATE transactions           SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
UPDATE monthly_plans          SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
UPDATE recurring_transactions SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
UPDATE debts                  SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
UPDATE conversation_messages  SET family_id = '00000000-0000-0000-0000-000000000001' WHERE family_id IS NULL;
-- merchant_category_map stays nullable; existing rows remain global.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enforce NOT NULL after backfill (except merchant_category_map)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users                   ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE transactions            ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE monthly_plans           ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE recurring_transactions  ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE debts                   ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE conversation_messages   ALTER COLUMN family_id SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Composite indexes for family-scoped hot paths
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_family          ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_txn_family_date       ON transactions(family_id, transaction_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plan_family_ym        ON monthly_plans(family_id, year, month);
CREATE INDEX IF NOT EXISTS idx_recurring_family      ON recurring_transactions(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_debts_family          ON debts(family_id) WHERE paid_off_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conv_family_chat_date ON conversation_messages(family_id, telegram_chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_family       ON merchant_category_map(family_id, merchant_pattern) WHERE family_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Drop the unique constraint on merchant_pattern (was global-unique)
-- Replace with (family_id, merchant_pattern) unique for per-family overrides
-- while still allowing a global fallback (family_id = null, merchant_pattern unique)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE merchant_category_map DROP CONSTRAINT IF EXISTS merchant_category_map_merchant_pattern_key;
-- Partial unique index: one row per (family_id, merchant_pattern) when family_id is set
CREATE UNIQUE INDEX IF NOT EXISTS uniq_merchant_family_pattern
  ON merchant_category_map(family_id, merchant_pattern)
  WHERE family_id IS NOT NULL;
-- Partial unique index: one global-fallback row per pattern
CREATE UNIQUE INDEX IF NOT EXISTS uniq_merchant_global_pattern
  ON merchant_category_map(merchant_pattern)
  WHERE family_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Drop the unique constraint on monthly_plans (was global year,month,category,type)
-- Replace with (family_id, year, month, category_id, plan_type)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_year_month_category_id_plan_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_monthly_plan_family
  ON monthly_plans(family_id, year, month, category_id, plan_type);
