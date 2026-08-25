#!/usr/bin/env bash
# concierge (GoStork) auto-sync for the MacBook: pull-only by default.
# Installed at ~/.gostork/auto-sync.sh, driven by the com.gostork.autosync
# LaunchAgent (StartInterval 60). Keep this repo copy in step with the installed
# one - it was unversioned until 2026-08-25, which is why the two machines
# drifted apart unnoticed.
#
# NOT the same mechanism as ops/imac-nightly-sync/auto-sync.sh. Do not swap one
# for the other - they differ in the two ways that matter:
#
#   |
#   | MacBook (this file)          | iMac
#   |-----------------------------|---------------------------------------
#   | pulls HERE, with --autostash | pulls inside the server daemon
#   | kickstarts only AFTER a      | kickstarts whenever local != remote,
#   |   successful pull            |   letting the daemon retry the pull
#   | gui/<uid>/com.gostork.server | system/com.gostork.nightly-sync
#
# The iMac's kickstart target does not exist on this Mac, so installing that
# file here would fail silently and stop auto-deploy altogether.
#
# Safe + non-destructive: fast-forwards/rebases only when strictly behind
# (--autostash preserves uncommitted work); conflicts abort untouched;
# divergence is logged, never auto-resolved.
#
# ATTEMPT CAP (added 2026-08-25): this side never had the iMac's restart storm -
# it only kickstarts after a pull SUCCEEDS, so a failing pull could not loop the
# server. But it had the same *silent staleness*: a pull that fails every cycle
# logs one identical line a minute forever and the box quietly runs old code.
# That is how six days passed on the iMac. After MAX_ATTEMPTS failures against
# the same remote SHA, say WEDGED with the commands to diagnose it.
#
# Config (from the LaunchAgent plist):
#   GS_REPO_DIR    (required) absolute path to the clone
#   GS_AUTO_PUSH   0|1  push local committed-but-unpushed commits (default 0 - company repo)
set -uo pipefail

REPO="${GS_REPO_DIR:?GS_REPO_DIR not set}"
AUTO_PUSH="${GS_AUTO_PUSH:-0}"
STATE_FILE="$HOME/.gostork/autosync-state"
MAX_ATTEMPTS=5
NAG_EVERY=30

cd "$REPO" || exit 0

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Failure bookkeeping is keyed by remote SHA: a new push always gets a fresh
# budget, and only repeated failure against the SAME target counts as wedged.
read_attempts() {
  local last_remote last_count
  [ -r "$STATE_FILE" ] || { echo 0; return; }
  read -r last_remote last_count < "$STATE_FILE" 2>/dev/null || { echo 0; return; }
  if [ "$last_remote" = "$1" ]; then echo "${last_count:-0}"; else echo 0; fi
}

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "$(ts) rebase/merge in progress - skipping"; exit 0
fi

git fetch -q origin main 2>/dev/null || { echo "$(ts) fetch failed (offline?) - skipping"; exit 0; }

LOCAL=$(git rev-parse @ 2>/dev/null)             || exit 0
REMOTE=$(git rev-parse origin/main 2>/dev/null)  || exit 0
BASE=$(git merge-base @ origin/main 2>/dev/null) || exit 0

if [ "$LOCAL" = "$REMOTE" ]; then
  rm -f "$STATE_FILE"   # in sync - clear any wedge state, stay quiet
  exit 0
fi

if [ "$LOCAL" = "$BASE" ]; then
  ATTEMPT=$(( $(read_attempts "$REMOTE") + 1 ))

  # Past the cap: go quiet, but do NOT give up permanently. Once every
  # NAG_EVERY cycles, shout AND retry - so an operator who fixes the tree
  # recovers on their own within ~30 minutes instead of needing to know that a
  # state file exists. Pure suppression looked tidy and was worse: the box
  # stayed stale after the problem was gone.
  if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
    if [ $((ATTEMPT % NAG_EVERY)) -ne 0 ]; then
      mkdir -p "$(dirname "$STATE_FILE")"
      echo "$REMOTE $ATTEMPT" > "$STATE_FILE"
      exit 0
    fi
    echo "$(ts) WEDGED: $ATTEMPT pulls toward ${REMOTE:0:7} have not advanced HEAD (still ${LOCAL:0:7}). This box is running STALE CODE. Check: git -C $REPO status --porcelain && git -C $REPO stash list"
    echo "$(ts) retrying anyway (1 in $NAG_EVERY) in case the tree was fixed"
  fi

  echo "$(ts) behind origin - pulling ${LOCAL:0:7}..${REMOTE:0:7} [attempt $ATTEMPT/$MAX_ATTEMPTS]"
  if ! git pull --rebase --autostash origin main; then
    echo "$(ts) PULL FAILED (attempt $ATTEMPT/$MAX_ATTEMPTS) - aborting, working tree left untouched"
    git rebase --abort 2>/dev/null || true
    git -C "$REPO" status --porcelain | head -20
    mkdir -p "$(dirname "$STATE_FILE")"
    echo "$REMOTE $ATTEMPT" > "$STATE_FILE"
    exit 0
  fi

  # Verify the pull actually moved HEAD. `git pull` can exit 0 having changed
  # nothing (autostash pop conflicts, hook interference), which would otherwise
  # reset the counter forever and recreate the silent-staleness bug.
  NOW=$(git rev-parse @ 2>/dev/null)
  if [ "$NOW" = "$LOCAL" ]; then
    echo "$(ts) PULL FAILED SILENTLY (attempt $ATTEMPT/$MAX_ATTEMPTS) - exit 0 but HEAD still ${LOCAL:0:7}"
    mkdir -p "$(dirname "$STATE_FILE")"
    echo "$REMOTE $ATTEMPT" > "$STATE_FILE"
    exit 0
  fi

  rm -f "$STATE_FILE"
  echo "$(ts) up to date at $(git rev-parse --short @) -> restarting server (rebuilds on start)"
  launchctl kickstart -k "gui/$(id -u)/com.gostork.server" 2>/dev/null || true
  exit 0
fi

if [ "$REMOTE" = "$BASE" ]; then
  if [ "$AUTO_PUSH" = "1" ]; then
    echo "$(ts) ahead of origin - pushing ${REMOTE:0:7}..${LOCAL:0:7}"
    git push origin main || echo "$(ts) push failed"
  fi
  exit 0
fi

echo "$(ts) DIVERGED - local and origin both moved; resolve by hand, not auto-syncing"
exit 0
