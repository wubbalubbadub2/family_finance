-- Day-1 re-engagement nudge gating.
-- Adds two columns to families:
--   reminders_disabled : opt-out flag. Auto-flips to TRUE when sendMessage
--                        returns "Forbidden: bot was blocked by the user".
--                        Also user-settable via /напоминания off.
--   last_nudge_sent_at : observability + idempotency. Cron short-circuits if
--                        already sent today (Almaty TZ) to survive Vercel
--                        retries.
--
-- Both columns are additive with safe defaults. No code path reads them
-- until the day1-nudge cron is deployed and enabled in vercel.json, so this
-- migration is independently shippable to prod with zero behavior change.

ALTER TABLE families
  ADD COLUMN IF NOT EXISTS reminders_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_nudge_sent_at  timestamptz;

-- Partial index for the "audience" query. Most families have
-- reminders_disabled=false; the index lets us skip opt-outs without scanning.
-- Tiny table at current scale (<10k rows), but cheap to add now.
CREATE INDEX IF NOT EXISTS idx_families_nudge_eligible
  ON families(id) WHERE reminders_disabled = false;
