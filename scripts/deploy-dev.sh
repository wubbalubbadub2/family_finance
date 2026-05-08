#!/usr/bin/env bash
# deploy-dev.sh — push to dev, wait for Vercel build, force git-dev alias
# to the new deploy. Workaround for the recurring auto-alias freeze on the
# git-dev preview alias (described in
# ~/.claude/.../memory/feedback_vercel_alias_check.md).
#
# Usage (from repo root):
#   ./scripts/deploy-dev.sh
#
# Idempotent: if there's nothing to push, still re-aliases to the current
# latest preview deploy (so it can also be used to "force re-alias now"
# after a push that auto-aliasing missed).

set -euo pipefail

ALIAS_HOST="family-finance-git-dev-shynggys-projects-1cd759b1.vercel.app"
ALIAS_URL="https://${ALIAS_HOST}"

# 1. Sanity: must be on dev branch.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "dev" ]; then
  echo "✗ Not on dev branch (currently '$BRANCH'). Run 'git checkout dev' first."
  exit 1
fi

# 2. Capture current alias target so we know what counts as "new".
BEFORE=$(vercel inspect "$ALIAS_URL" 2>&1 \
  | grep "Fetched deployment" \
  | sed 's/.*"\([^"]*\)".*/\1/' || true)
echo "→ Current alias points to: ${BEFORE:-<unknown>}"

# 3. Push (no-op if nothing to push).
echo "→ git push origin dev"
git push origin dev

# 4. Wait for a NEW preview deploy to appear and be Ready. Poll up to 5 min.
echo "→ Waiting for Vercel build (up to 5 min)..."
NEW_DEPLOY=""
for i in $(seq 1 60); do
  sleep 5
  # vercel ls preview — newest first.
  LATEST_LINE=$(vercel ls 2>/dev/null | grep "Preview" | head -1 || true)
  if [ -z "$LATEST_LINE" ]; then continue; fi

  LATEST_URL=$(echo "$LATEST_LINE" | awk '{print $3}')
  LATEST_HOST="${LATEST_URL#https://}"
  STATUS=$(echo "$LATEST_LINE" | awk '{print $5}')

  # Skip if it's the same deploy we started from AND no Ready signal yet.
  if [ "$LATEST_HOST" = "$BEFORE" ]; then
    # Same deploy still latest — push was a no-op, OR build hasn't started.
    # Wait one more cycle then exit the wait loop (nothing new to deploy).
    if [ "$i" -ge 6 ]; then
      echo "→ No new deploy after 30s (push was likely a no-op). Re-aliasing to current latest."
      NEW_DEPLOY="$LATEST_URL"
      break
    fi
    continue
  fi

  # Different deploy — wait for Ready.
  if echo "$STATUS" | grep -q "Ready"; then
    NEW_DEPLOY="$LATEST_URL"
    echo "→ New deploy Ready: $NEW_DEPLOY (took ~$((i*5))s)"
    break
  fi
done

if [ -z "$NEW_DEPLOY" ]; then
  echo "✗ Timed out waiting for build. Check 'vercel ls' manually and run 'vercel alias set <url> $ALIAS_HOST'."
  exit 1
fi

# 5. Re-alias.
echo "→ Setting alias $ALIAS_HOST → $NEW_DEPLOY"
vercel alias set "$NEW_DEPLOY" "$ALIAS_HOST"

# 6. Verify.
AFTER=$(vercel inspect "$ALIAS_URL" 2>&1 \
  | grep "Fetched deployment" \
  | sed 's/.*"\([^"]*\)".*/\1/')
EXPECTED="${NEW_DEPLOY#https://}"
if [ "$AFTER" = "$EXPECTED" ]; then
  echo "✓ Alias verified: $ALIAS_HOST → $AFTER"
else
  echo "✗ Alias verification failed. Expected $EXPECTED, got $AFTER."
  exit 1
fi
