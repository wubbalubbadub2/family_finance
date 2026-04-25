-- Error log for observability. Replaces dependency on Vercel-only log retention.
-- Every captured error inserts a row; daily cron summarizes + DMs admin on anomalies.
--
-- We keep this lightweight on purpose: no foreign keys, no complex types. The point
-- is "we lost it once, we won't lose it again." If a row fails to insert (e.g. during
-- DB outage), capture() falls back to console.error — see src/lib/observability.ts.

CREATE TABLE IF NOT EXISTS error_log (
  id          BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      TEXT NOT NULL,            -- e.g. 'webhook', 'cron:weekly-digest', 'agent:read-tool'
  family_id   UUID,                     -- nullable: not all errors have a family context
  user_tg_id  BIGINT,                   -- nullable: not all errors have a user context
  message     TEXT NOT NULL,            -- error.message (or String(error) if not Error)
  stack       TEXT,                     -- error.stack (truncated to ~4KB)
  context     JSONB                     -- arbitrary structured metadata
);

CREATE INDEX IF NOT EXISTS idx_error_log_occurred_at ON error_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_family ON error_log(family_id, occurred_at DESC) WHERE family_id IS NOT NULL;

-- Auto-expire old rows after 90 days. Errors older than that are anomalies, not signal.
-- Daily cleanup cron runs DELETE … WHERE occurred_at < NOW() - INTERVAL '90 days'.
COMMENT ON TABLE error_log IS '90-day retention; cleaned by api/cron/cleanup';
