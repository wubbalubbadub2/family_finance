-- 016: Capture Telegram @username on each user.
--
-- The admin dashboard needs to map a paying user's DM to their family row.
-- Today we only store first_name (which can collide), no @username, no
-- telegram_id surfaced in the UI. This column adds the @handle Telegram
-- exposes via ctx.from.username — letting admin Ctrl+F by handle when
-- a Kaspi receipt comes in.
--
-- Nullable on purpose: many Telegram users haven't set a @username, and
-- forcing it would block onboarding for them. Falls back to first_name +
-- short verification code in the paywall message.

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username text;

-- Index keeps the dashboard search-by-handle fast even at 10k+ users.
CREATE INDEX IF NOT EXISTS idx_users_telegram_username
  ON users(telegram_username) WHERE telegram_username IS NOT NULL;
