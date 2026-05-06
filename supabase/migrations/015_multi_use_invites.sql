-- 015: Allow public/perpetual invite links.
--
-- Today every invite is single-use: one code → one pre-created family. That
-- forces the admin to manually generate one link per paying customer, which
-- doesn't scale past ~50/day.
--
-- Public-link semantics: when uses_remaining IS NULL, the invite is unlimited.
-- Each redemption creates a FRESH family for the redeemer (using their
-- Telegram first_name) instead of attaching to a pre-existing family. The
-- 3-day trial paid_until is set on the new family at creation time.
--
-- The CHECK constraint `(uses_remaining >= 0)` from migration 009 already
-- allows NULL (NULL passes CHECK), so we only need to drop NOT NULL.

ALTER TABLE family_invites ALTER COLUMN uses_remaining DROP NOT NULL;
