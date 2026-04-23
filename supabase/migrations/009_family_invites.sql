-- 009: Family invite codes for self-service onboarding.
-- Admin generates a link via `/newfamily <name>` or `/invite`. New user taps
-- the Telegram deep link — bot creates their user row and links to the
-- invited family automatically. No SQL, no env var edits.

CREATE TABLE IF NOT EXISTS family_invites (
  code text PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,  -- optional; null = never expires
  uses_remaining int NOT NULL DEFAULT 1 CHECK (uses_remaining >= 0)
);

CREATE INDEX IF NOT EXISTS idx_family_invites_family ON family_invites(family_id);
