-- 008: Pending confirm storage for write-gated Claude tools.
-- When Claude proposes a write (create_goal, contribute_to_goal, etc.), the
-- bot stores the proposed args here and asks the user to tap ✅ Да or ❌ Отмена.
-- The callback_query handler validates the nonce and executes OR cancels.
--
-- Structure of pending_confirm jsonb:
--   {
--     "nonce": "a7f3",           // short random, also embedded in callback_data
--     "type": "create_goal",     // tool name
--     "args": { ... },           // tool args
--     "stored_at": "2026-..."    // ISO, used for TTL (default 10 min)
--   }
--
-- Only one pending confirm per family at a time. New proposal overwrites old.
-- This is acceptable because the user is always in a single conversation turn.

ALTER TABLE families ADD COLUMN IF NOT EXISTS pending_confirm jsonb;

-- No index needed — always accessed by family_id which is already the PK.
