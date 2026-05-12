-- bot_actions_log: per-bot-action telemetry for replay + cost monitoring.
--
-- Motivation (2026-05-12): the Day-1 nudge cron needs an audit trail (who got
-- nudged, when, did it succeed) and the chat() pipeline needs operational
-- telemetry (latency, tool-call shape, cache hit rate) so we can debug user
-- incidents without screenshot guessing.
--
-- PRIVACY: v1 stores ONLY shape data. No raw user text. No tool-call args.
-- Tool names yes (operational; not PII). When task #31 (PII scrubber) ships,
-- a sanitized user_message_snippet column can be added; for now the design
-- premise is "fail safe" — if it might be PII, don't store it.

CREATE TABLE IF NOT EXISTS bot_actions_log (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  family_id       UUID,                          -- nullable: not all actions have family context
  source          TEXT NOT NULL,                 -- 'chat' | 'cron:day1_nudge' | 'webhook' | etc.
  tool_names      TEXT[],                        -- names of tools Sonnet invoked, no args (no PII)
  iterations      INTEGER,                       -- chat() loop turns (null for non-chat sources)
  reply_length    INTEGER,                       -- length of final bot reply (no content stored)
  latency_ms      INTEGER,
  input_tokens    INTEGER,                       -- cumulative across loop iterations
  output_tokens   INTEGER,
  cache_read      INTEGER,                       -- Anthropic cache_read_input_tokens
  cache_write     INTEGER,                       -- Anthropic cache_creation_input_tokens
  meta            JSONB                          -- extension slot (model, recovery flags, etc.)
);

CREATE INDEX IF NOT EXISTS idx_bot_actions_log_occurred_at ON bot_actions_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_actions_log_source ON bot_actions_log(source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_actions_log_family ON bot_actions_log(family_id, occurred_at DESC) WHERE family_id IS NOT NULL;

-- 90-day retention matches error_log. Daily cleanup cron extends to purge old rows.
COMMENT ON TABLE bot_actions_log IS '90-day retention; cleaned by api/cron/cleanup';
