-- 006: Goals, goal contributions, per-family category overrides, and pending
-- wizard state on families. Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- Goals (v1 constraint: max one active goal per family, enforced at query layer)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name             text NOT NULL,
  target_amount    int  NOT NULL CHECK (target_amount > 0),
  deadline         date NOT NULL,
  current_amount   int  NOT NULL DEFAULT 0 CHECK (current_amount >= 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

-- Partial unique index: at most one ACTIVE goal per family.
-- (Archived/completed goals can accumulate; only the active one is the "current bet.")
CREATE UNIQUE INDEX IF NOT EXISTS uniq_goal_family_active
  ON goals(family_id)
  WHERE status = 'active';

-- Query hot path: fetch active goal for a family
CREATE INDEX IF NOT EXISTS idx_goals_family_status
  ON goals(family_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Goal contributions (audit trail for /save)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_contributions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id      uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount       int  NOT NULL CHECK (amount > 0),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_contrib_goal_date
  ON goal_contributions(goal_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-family category overrides (keyword → category_slug).
-- Pre-Haiku lookup: if a keyword matches, use the override deterministically.
-- On user correction (tap 🏷 on /recent or NL "это было X"), upsert here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS category_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  keyword             text NOT NULL,  -- normalized: lowercased, trimmed
  category_slug       text NOT NULL,  -- home, food, transport, cafe, baby, health, credit, personal, savings, misc
  created_by_user_id  uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_cat_override_family_keyword
  ON category_overrides(family_id, keyword);

-- ─────────────────────────────────────────────────────────────────────────────
-- Pending wizard state on families
-- Serverless-safe state machine — each step atomically advances via
-- UPDATE ... WHERE pending_goal_step = $expected RETURNING *
-- If RETURNING is empty, another concurrent invocation already advanced.
--
-- pending_list_context is used for "ещё" pagination of /recent results.
-- pending_started_at enables the 24h stale cleanup cron.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE families ADD COLUMN IF NOT EXISTS pending_goal_step       text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS pending_goal_data       jsonb;
ALTER TABLE families ADD COLUMN IF NOT EXISTS pending_list_context    jsonb;
ALTER TABLE families ADD COLUMN IF NOT EXISTS pending_started_at      timestamptz;

-- Check constraint: valid step names (enforced in DB so a typo can't wedge families)
ALTER TABLE families DROP CONSTRAINT IF EXISTS families_pending_goal_step_check;
ALTER TABLE families ADD CONSTRAINT families_pending_goal_step_check
  CHECK (pending_goal_step IS NULL OR pending_goal_step IN ('pick_name', 'pick_amount', 'pick_deadline', 'confirm'));
