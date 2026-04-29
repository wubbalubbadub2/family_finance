-- 012: Chat-based family scope. Each Telegram chat (DM or group) maps to one family.
-- Replaces "users.family_id" as the primary scope mechanism — that column stays for
-- backward-compat but is not authoritative for new logic.
--
-- Why: Phase 2 lets a family use the bot in DM AND in their Telegram group
-- simultaneously. The chat (private OR group) determines which family's books
-- the messages write into. Adding the bot to a group auto-links that group
-- to the sender's family on the first message.

CREATE TABLE IF NOT EXISTS family_chats (
  chat_id BIGINT PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  chat_type TEXT NOT NULL,  -- 'private' | 'group' | 'supergroup'
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_family_chats_family ON family_chats(family_id);

-- Backfill: every existing user's DM with the bot is implicitly linked to their family.
-- Telegram private chat IDs equal the user's telegram_id, so we can synthesize the
-- private-chat link from the users table without touching Telegram itself.
INSERT INTO family_chats (chat_id, family_id, chat_type, linked_at, linked_by_user_id)
SELECT u.telegram_id, u.family_id, 'private', u.created_at, u.id
FROM users u
WHERE u.family_id IS NOT NULL
ON CONFLICT (chat_id) DO NOTHING;
