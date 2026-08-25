#!/usr/bin/env bash
# Per-machine auto-sync: pull+build+restart this box ~60s after a push to main.
# Installed at ~/.gostork/auto-sync.sh, driven by the com.gostork.autosync
# LaunchAgent (StartInterval 60). A versioned copy lives in the repo at
# ops/imac-nightly-sync/auto-sync.sh - keep them in step.
#
# ATTEMPT CAP (added 2026-08-25): this used to kickstart the server daemon
# every 60 seconds for as long as local != origin/main. When the daemon's own
# `git pull` could not succeed - a dirty working tree aborts `--rebase` - that
# was an infinite restart loop on stale code: 8,772 restarts over six days,
# entirely silent because every log line looked like normal progress. Now a
# given remote SHA gets MAX_ATTEMPTS restarts; after that the loop is suppressed
# and the log says WEDGED instead of pretending to make progress.
set -uo pipefail
REPO="$HOME/GitHub-iMac/concierge"
STATE_FILE="$HOME/.gostork/autosync-state"
MAX_ATTEMPTS=5
NAG_EVERY=30

cd "$REPO" || exit 0
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then exit 0; fi
git fetch -q origin main 2>/dev/null || exit 0
LOCAL=$(git rev-parse @ 2>/dev/null) || exit 0
REMOTE=$(git rev-parse origin/main 2>/dev/null) || exit 0
BASE=$(git merge-base @ origin/main 2>/dev/null) || exit 0

# Up to date: clear any wedge state so the next real push starts from attempt 1.
if [ "$LOCAL" = "$REMOTE" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi

if [ "$LOCAL" != "$BASE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') diverged/ahead -> skipping"
  exit 0
fi

# Count attempts against THIS remote SHA.
#
# NOTE: unlike the MacBook script, this one does not pull - the daemon does,
# inside run-server.sh. That makes the "pull exited 0 but HEAD did not move"
# case self-handling: the only thing that clears this counter is LOCAL actually
# reaching REMOTE (above). A daemon pull that silently no-ops leaves LOCAL !=
# REMOTE, so the next cycle increments ATTEMPT and counts it as the failure it
# is. Do not "improve" this by resetting the counter on a successful kickstart -
# that reintroduces the silent-staleness bug this cap exists to catch.
LAST_REMOTE=""; LAST_COUNT=0
if [ -r "$STATE_FILE" ]; then
  read -r LAST_REMOTE LAST_COUNT < "$STATE_FILE" 2>/dev/null || true
  [ -n "${LAST_COUNT:-}" ] || LAST_COUNT=0
fi
if [ "$LAST_REMOTE" = "$REMOTE" ]; then
  ATTEMPT=$((LAST_COUNT + 1))
else
  ATTEMPT=1
fi
mkdir -p "$(dirname "$STATE_FILE")"
echo "$REMOTE $ATTEMPT" > "$STATE_FILE"

# Past the cap: stay quiet MOST cycles, but every NAG_EVERY-th cycle shout AND
# retry. Pure suppression was the first version of this guard and it was wrong:
# once an operator cleaned the tree, nothing ever tried again, so the box stayed
# silently stale until a human happened to notice - the exact failure the cap was
# added to prevent, just quieter. Retrying 1-in-NAG_EVERY means a fixed tree
# self-heals within ~30 minutes with no knowledge of this state file required.
if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
  if [ $((ATTEMPT % NAG_EVERY)) -ne 0 ]; then
    exit 0
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') WEDGED: $ATTEMPT attempts to reach ${REMOTE:0:7} have not advanced HEAD (still ${LOCAL:0:7}). This box is running STALE CODE. Check: git -C $REPO status --porcelain, and grep 'PULL FAILED' /tmp/gostork-server.log"
  echo "$(date '+%Y-%m-%d %H:%M:%S') retrying anyway (1 in $NAG_EVERY) in case the tree was fixed"
  # falls through to the kickstart below
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') new commits ${LOCAL:0:7}..${REMOTE:0:7} -> restarting daemon (pull+build) [attempt $ATTEMPT/$MAX_ATTEMPTS]"
sudo -n /bin/launchctl kickstart -k system/com.gostork.nightly-sync
