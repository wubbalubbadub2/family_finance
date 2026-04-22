-- 007: Per-family categories — each family owns its own category list
-- with CRUD operations (add/rename/delete/merge). Existing global categories
-- are backfilled to the default family. Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add family_id to categories (nullable at first for safe backfill)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE categories ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES families(id) ON DELETE CASCADE;

-- Backfill existing global categories to the default family
UPDATE categories
  SET family_id = '00000000-0000-0000-0000-000000000001'
  WHERE family_id IS NULL;

-- Enforce NOT NULL after backfill
ALTER TABLE categories ALTER COLUMN family_id SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Reshape UNIQUE constraint: was global UNIQUE(slug), now UNIQUE(family_id, slug)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_category_family_slug
  ON categories(family_id, slug);

CREATE INDEX IF NOT EXISTS idx_categories_family_active
  ON categories(family_id, is_active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper function to seed default categories for a new family.
-- Matches the original 10 from migration 001. New families (e.g., psychologist's)
-- call this once on creation so they start with a sane default taxonomy.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION seed_default_categories_for_family(p_family_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO categories (family_id, name, emoji, slug, sort_order, is_active) VALUES
    (p_family_id, 'Жильё',        '🏠', 'home',      1, true),
    (p_family_id, 'Продукты',     '🛒', 'food',      2, true),
    (p_family_id, 'Транспорт',    '🚗', 'transport', 3, true),
    (p_family_id, 'Кафе & выход', '☕', 'cafe',      4, true),
    (p_family_id, 'Балапанчик',   '👶', 'baby',      5, true),
    (p_family_id, 'Здоровье',     '💊', 'health',    6, true),
    (p_family_id, 'Кредиты',      '💳', 'credit',    7, true),
    (p_family_id, 'Личное',       '🎯', 'personal',  8, true),
    (p_family_id, 'Savings',      '💰', 'savings',   9, true),
    (p_family_id, 'Разное',       '🎲', 'misc',     10, true)
  ON CONFLICT (family_id, slug) DO NOTHING;  -- idempotent: re-running for same family is a no-op
END;
$$;
