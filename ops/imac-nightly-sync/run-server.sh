#!/bin/bash
# Long-lived GoStork server for the always-on iMac, which is now the SOLE host
# of the nightly scraper sync (Replit Autoscale reaps background jobs mid-run).
#
# - ENABLE_NIGHTLY_SCHEDULER=true turns on the in-process node-cron (2 AM ET) +
#   the boot-time catch-up. This MUST be set on exactly ONE always-on machine.
#   Do NOT set it on the MacBook or on Replit, or nightly runs pile up.
# - `caffeinate -is` keeps the Mac (and disk) awake for as long as this process
#   runs, so node-cron timers actually fire at 2 AM instead of being frozen by
#   system sleep. launchd KeepAlive keeps the process running, so the machine
#   effectively never idle-sleeps.
# - Runs the PRODUCTION build (dist/index.cjs). Rebuild after pulling new code.
set -euo pipefail

# Absolute path to the repo on the iMac. The iMac's working clone is GitHub-iMac
# (NOT plain GitHub). Override with GOSTORK_REPO_DIR from the plist if it moves.
REPO_DIR="${GOSTORK_REPO_DIR:-$HOME/GitHub-iMac/concierge}"
cd "$REPO_DIR"

export NODE_ENV=production
export ENABLE_NIGHTLY_SCHEDULER=true

# Pull latest, install any NEW dependencies, then rebuild, so the iMac always
# runs current code. `npm install` is NOT optional: a pull that introduces a new
# package (e.g. livekit-client, added 2026-08-01) leaves node_modules stale, the
# vite build then fails to resolve the import, and - because of `set -e` - this
# script died before `exec`, so launchd KeepAlive restarted it every ~2s forever
# and the server never came up at all. That silently killed 2 nights of syncs.
#
# `git pull --rebase` ABORTS on any unstaged change ("cannot pull with rebase:
# You have unstaged changes") and this used to be a swallowed one-line warning.
# Aug 19-25 2026: a stray npm-generated package-lock.json (just `"peer": true`
# noise) made every pull abort, so this script booted the PREVIOUS build, and
# auto-sync - seeing local != remote a minute later - kickstarted it again.
# 8,772 restarts over six days, all on 70-commit-stale code, with nobody
# alerted. So: auto-recover from the one file that is always safe to discard
# (npm rewrites package-lock.json from package.json), and if the pull still
# fails, fail LOUDLY and greppably instead of pretending it worked.
if ! git pull origin main --rebase; then
  if ! git diff --quiet -- package-lock.json 2>/dev/null; then
    echo "[run-server] pull blocked by a modified package-lock.json (npm noise) - discarding it and retrying"
    git checkout -- package-lock.json || true
  fi
  if ! git pull origin main --rebase; then
    echo "[run-server] PULL FAILED - booting the existing build on STALE code. Dirty working tree:"
    git status --porcelain | head -20
    echo "[run-server] PULL FAILED - clean the working tree or this machine restarts every 60s and never advances. HEAD=$(git rev-parse --short HEAD 2>/dev/null) origin/main=$(git rev-parse --short origin/main 2>/dev/null)"
  fi
fi
# --include=dev is REQUIRED: NODE_ENV=production is exported above, which makes
# a bare `npm install` skip AND prune devDependencies - deleting vite/esbuild
# and guaranteeing the build below fails forever (stale-dist fallback on every
# restart). Dev deps must be present because this script builds, not just runs.
npm install --include=dev || echo "[run-server] WARNING: npm install failed - build may fail below"

# Skip the rebuild when dist is already fresher than the (just-pulled) HEAD -
# an unconditional rebuild empties dist for ~12s and the site serves "Not
# Found" to anyone browsing during a restart (observed on the MacBook
# 2026-08-03). After a pull that brought new commits, HEAD is newer than
# dist and the rebuild still runs.
HEAD_TS=$(git log -1 --format=%ct 2>/dev/null || echo 0)
DIST_TS=$(stat -f %m dist/index.cjs 2>/dev/null || echo 0)
if [ -f dist/public/index.html ] && [ "$DIST_TS" -ge "$HEAD_TS" ]; then
  echo "[run-server] dist is fresh (built after HEAD) - skipping rebuild"
# A build failure must NOT take the nightly sync offline. If a previous
# dist/index.cjs exists, boot that (loudly degraded) instead of crash-looping;
# the sleep keeps launchd from spinning when there is nothing to fall back to.
elif ! npm run build; then
  echo "[run-server] ERROR: npm run build FAILED - see the vite/esbuild error above."
  if [ -f dist/index.cjs ]; then
    echo "[run-server] ERROR: booting the PREVIOUS dist/index.cjs so the 2 AM sync still runs. THIS BUILD IS STALE - fix the build."
  else
    echo "[run-server] FATAL: no previous dist/index.cjs to fall back to. Sleeping 60s to avoid a launchd crash-loop."
    sleep 60
    exit 1
  fi
fi

exec caffeinate -is node dist/index.cjs
