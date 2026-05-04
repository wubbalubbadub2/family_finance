-- 014: Idempotency at the Telegram webhook layer.
--
-- Why webhook-level instead of transaction-level: a single Telegram message
-- can produce multiple transactions (e.g. "молоко 500 и хлеб 300" → two rows).
-- A `(family_id, tg_message_id)` UNIQUE on transactions would wrongly block
-- the second item. Deduplicating at the update_id level handles all paths
-- (transactions, debts, goals, callbacks) with a single guarantee:
-- "we'll never process the same Telegram update twice."
--
-- Telegram retries the same update_id when our webhook returns 5xx or times
-- out (default 60s). Without this table, a slow Sonnet call that 504s would
-- get retried, the user's expense would be logged twice, and our trust dies.

CREATE TABLE IF NOT EXISTS telegram_updates_processed (
  update_id    bigint      PRIMARY KEY,
  chat_id      bigint      NOT NULL,
  message_id   bigint,                      -- nullable: callback_query has no message_id
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Daily cleanup keeps this table small. Telegram retry window is well under
-- an hour in practice, so 24h is more than enough.
CREATE INDEX IF NOT EXISTS idx_telegram_updates_processed_at
  ON telegram_updates_processed(processed_at);
