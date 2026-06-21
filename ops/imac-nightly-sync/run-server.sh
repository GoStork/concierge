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
REPO_DIR="${GOSTORK_REPO_DIR:-$HOME/Documents/GitHub-iMac/concierge}"
cd "$REPO_DIR"

export NODE_ENV=production
export ENABLE_NIGHTLY_SCHEDULER=true

# Pull latest + rebuild so the iMac always runs current code. Safe to remove
# these two lines if you prefer to build manually before (re)starting.
git pull origin main --rebase || echo "[run-server] git pull failed - running existing build"
npm run build

exec caffeinate -is node dist/index.cjs
