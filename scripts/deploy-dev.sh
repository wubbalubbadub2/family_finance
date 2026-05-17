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
# Sets DEPLOY_DEV_SCRIPT=1 to satisfy the .git/hooks/pre-push gate that
# blocks bare `git push origin dev` (added 2026-05-18 after repeated alias
# drift incidents — manual git push leaves the alias frozen because nothing
# downstream re-points it).
echo "→ git push origin dev"
DEPLOY_DEV_SCRIPT=1 git push origin dev

# 4. Wait for a NEW preview deploy to appear and be Ready. Poll up to 5 min.
# Vercel can take 60-90s to even REGISTER a new deploy after a push (let alone
# build it). The earlier heuristic that bailed at 30s with "push was no-op"
# was wrong — it assumed instant deploy registration. Now we patiently wait
# the full 5 min for a new-and-Ready deploy. If after 5 min nothing has
# changed, fall back to re-aliasing the current latest (the genuine no-op
# case where source files didn't change).
echo "→ Waiting for Vercel build (up to 5 min)..."
NEW_DEPLOY=""
for i in $(seq 1 60); do
  sleep 5
  LATEST_LINE=$(vercel ls 2>&1 | grep "Preview" | head -1 || true)
  if [ -z "$LATEST_LINE" ]; then continue; fi

  LATEST_URL=$(echo "$LATEST_LINE" | awk '{print $3}')
  LATEST_HOST="${LATEST_URL#https://}"
  STATUS=$(echo "$LATEST_LINE" | awk '{print $5}')

  if [ "$LATEST_HOST" = "$BEFORE" ]; then
    continue  # No new deploy yet; keep waiting.
  fi

  if echo "$STATUS" | grep -q "Ready"; then
    NEW_DEPLOY="$LATEST_URL"
    echo "→ New deploy Ready: $NEW_DEPLOY (took ~$((i*5))s)"
    break
  fi
done

# Fallback: nothing new after 5 min — push was likely a true no-op (no source
# files changed). Re-alias to current latest so the alias stays current.
if [ -z "$NEW_DEPLOY" ]; then
  LATEST_LINE=$(vercel ls 2>&1 | grep "Preview" | head -1 || true)
  if [ -n "$LATEST_LINE" ]; then
    LATEST_URL=$(echo "$LATEST_LINE" | awk '{print $3}')
    echo "→ No new deploy after 5 min — re-aliasing to current latest ($LATEST_URL)."
    NEW_DEPLOY="$LATEST_URL"
  else
    echo "✗ No preview deploys found. Check 'vercel ls' manually."
    exit 1
  fi
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
