-- seed.sql — reference SQL for onboarding a new family.
--
-- This file is NOT applied automatically. Run snippets from it manually in the
-- Supabase SQL Editor when onboarding a new family. Every step is commented
-- with what you need to substitute.
--
-- The default family (Shynggys's) is already set up via migration 005. Only
-- run the "onboard new family" block below when adding a paying customer.

-- ─────────────────────────────────────────────────────────────────────────────
-- ONBOARD NEW FAMILY — run this once per paying customer family.
--
-- Replace placeholders before running:
--   <FAMILY_NAME>          human-readable name, e.g., "Psychologist Family"
--   <FAMILY_CHAT_ID>       bigint, Telegram chat ID where cron notifications
--                          go. For 1-on-1 DMs, this is the member's user ID.
--   <MEMBER_TG_ID_1>       bigint, Telegram user ID of first family member
--   <MEMBER_NAME_1>        string, display name
--   <MEMBER_TG_ID_2>       bigint, second member (can skip if 1-member family)
--   <MEMBER_NAME_2>        string
--
-- After running, add these IDs to ALLOWED_TELEGRAM_IDS env var on Vercel.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: create the family row, capture its ID
WITH new_family AS (
  INSERT INTO families (name, primary_chat_id)
  VALUES ('<FAMILY_NAME>', <FAMILY_CHAT_ID>)
  RETURNING id
)
-- Step 2: add family members (add one INSERT per user)
INSERT INTO users (telegram_id, name, family_id) VALUES
  (<MEMBER_TG_ID_1>, '<MEMBER_NAME_1>', (SELECT id FROM new_family))
  -- add more rows:
  -- ,(<MEMBER_TG_ID_2>, '<MEMBER_NAME_2>', (SELECT id FROM new_family))
  RETURNING family_id, id, name;

-- Step 3: seed the 10 default categories for this family.
-- Replace <FAMILY_UUID> with the family_id returned above.
-- SELECT seed_default_categories_for_family('<FAMILY_UUID>');

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — sanity-check the new family before first use
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT f.*, count(u.id) AS members, count(c.id) AS categories
-- FROM families f
-- LEFT JOIN users u ON u.family_id = f.id
-- LEFT JOIN categories c ON c.family_id = f.id
-- WHERE f.id = '<FAMILY_UUID>'
-- GROUP BY f.id;

-- Expected: members ≥ 1, categories = 10.

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL: create a test goal for the family (bypasses the wizard UX).
-- Useful for demoing the goal progress line on their first expense.
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT INTO goals (family_id, name, target_amount, deadline, status)
-- VALUES ('<FAMILY_UUID>', 'Отпуск 2026', 1000000, '2026-12-31', 'active');
