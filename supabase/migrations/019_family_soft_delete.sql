-- Family-level soft-delete for the /удалить_все feature.
--
-- When a user runs /удалить_все and confirms, the bot calls
-- soft_wipe_family_data(family_id). The family is MARKED deleted via
-- families.deleted_at; bot interactions are gated on this flag in
-- handlers.ts. Transactions are also soft-marked via the existing
-- transactions.deleted_at convention so they immediately disappear from
-- every existing read path.
--
-- Categories, debts, monthly_plans, goals, conversation_messages are
-- intentionally LEFT in the DB — they're hidden behind the family-level
-- gate, not individually deleted. This keeps the wipe atomic + minimal
-- and avoids needing per-table deleted_at columns we don't have today.
--
-- Recoverable by admin: UPDATE families SET deleted_at = NULL ... and
-- UPDATE transactions SET deleted_at = NULL ... using the timestamp
-- captured in bot_actions_log.

ALTER TABLE families
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index for the common "active families only" query path. Most
-- families have deleted_at IS NULL; this lets us skip the wiped ones.
CREATE INDEX IF NOT EXISTS idx_families_deleted_at_active
  ON families(id) WHERE deleted_at IS NULL;

-- Atomic soft-wipe. Postgres function bodies are transactional by default
-- — full rollback on any error.
CREATE OR REPLACE FUNCTION soft_wipe_family_data(p_family_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx_count int;
  v_now timestamptz := now();
BEGIN
  -- Audit row BEFORE the wipe. Captured first so even if the wipe fails
  -- and rolls back, we have no audit (which is correct — nothing happened).
  -- On success: the audit row commits with the rest atomically.
  -- bot_actions_log has no FK constraint to families, so the audit row
  -- outlives the family-deleted flag transparently.
  INSERT INTO bot_actions_log (source, family_id, meta, reply_length, latency_ms)
  VALUES ('soft_wipe_family_data', p_family_id,
          jsonb_build_object('wipe', true, 'wiped_at', v_now),
          0, 0);

  -- Soft-mark transactions using the existing pattern. Existing reads
  -- already filter `WHERE deleted_at IS NULL`, so transactions vanish
  -- from summaries instantly.
  UPDATE transactions
    SET deleted_at = v_now
    WHERE family_id = p_family_id AND deleted_at IS NULL;
  GET DIAGNOSTICS v_tx_count = ROW_COUNT;

  -- Mark the family as wiped. The wiped-family gate in handlers.ts
  -- short-circuits further bot interactions until /start re-onboards.
  UPDATE families
    SET deleted_at = v_now
    WHERE id = p_family_id AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'transactions_soft_deleted', v_tx_count,
    'family_marked_deleted', true,
    'wiped_at', v_now
  );
END;
$$;
