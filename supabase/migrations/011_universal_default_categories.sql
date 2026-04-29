-- 011: Replace family-specific default categories with universal ones.
--
-- The previous seed (migration 007) included "Балапанчик" (Kazakh for "little
-- baby") and "Savings" (English) — both inherited from the founder's own
-- family setup. As paying clients arrive (most don't have babies, all are
-- Russian-speaking), these defaults feel weird and need overriding.
--
-- New defaults are 8 universal categories that fit any KZ household:
--   Продукты, Жильё, Транспорт, Кафе, Здоровье, Личное, Накопления, Разное
--
-- This migration only changes FUTURE seeded families. Existing families keep
-- whatever categories they already have (idempotent ON CONFLICT pattern).
-- Founder's own family with Балапанчик etc. is untouched — those rows already
-- exist in `categories` and the seed function ignores conflicts.

CREATE OR REPLACE FUNCTION seed_default_categories_for_family(p_family_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO categories (family_id, name, emoji, slug, sort_order, is_active) VALUES
    (p_family_id, 'Продукты',    '🛒', 'food',       1, true),
    (p_family_id, 'Жильё',       '🏠', 'home',       2, true),
    (p_family_id, 'Транспорт',   '🚗', 'transport',  3, true),
    (p_family_id, 'Кафе',        '☕', 'cafe',       4, true),
    (p_family_id, 'Здоровье',    '💊', 'health',     5, true),
    (p_family_id, 'Личное',      '🎯', 'personal',   6, true),
    (p_family_id, 'Накопления',  '💰', 'savings',    7, true),
    (p_family_id, 'Разное',      '🎲', 'misc',       8, true)
  ON CONFLICT (family_id, slug) DO NOTHING;
END;
$$;
