-- 013: paid_until on families — 3-day trial gate.
--
-- Each family now has a paid_until timestamp. The bot refuses messages from
-- expired families with a paywall reply (see src/lib/bot/paywall.ts).
--
-- Backfill: existing rows get '2099-01-01' (effectively unlimited). The user
-- trims each one to the real paid-through date manually via /admin/families.
-- Inverted from initial design — far-future default means a paying customer
-- can never get accidentally locked out, and the failure mode is "they get
-- extra free days" instead of "trust-breaking lockout."
--
-- New families inserted post-migration get an EXPLICIT paid_until from code
-- (createFamily + scripts/new-prod-invite.ts), set to now() + 3 days. We do
-- NOT set a DB DEFAULT — silent defaults are footguns if anyone ever inserts
-- via psql.

ALTER TABLE families ADD COLUMN paid_until timestamptz;

UPDATE families
   SET paid_until = '2099-01-01'::timestamptz
 WHERE paid_until IS NULL;

ALTER TABLE families ALTER COLUMN paid_until SET NOT NULL;
