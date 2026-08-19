#!/bin/bash
# GoStork 2.0 auto-deploy: pull origin/main, rebuild, migrate, restart.
# Runs from gostork-deploy.timer every minute. Log: journalctl -u gostork-deploy
#
# Correctness rules (learned 2026-08-19):
# - Compare origin/main against the LAST SUCCESSFULLY DEPLOYED sha (marker
#   file), never against git HEAD: a build that fails after `git reset --hard`
#   must not look "deployed" to the next run.
# - A failed sha is retried after a 15-min backoff (or immediately when a newer
#   commit lands) so a transient failure self-heals and a real one keeps
#   shouting WARN in the journal instead of silently sticking.
set -uo pipefail
APP=/srv/gostork/app
STATE=/srv/gostork/.deploy-state        # sha of the last successful deploy
FAILED=/srv/gostork/.deploy-failed      # "<sha> <epoch>" of the last failed attempt
LOCK=/run/lock/gostork-deploy.lock
exec 9>"$LOCK"; flock -n 9 || { echo "deploy already running"; exit 0; }
cd "$APP"
sudo -u gostork git fetch -q origin main || { echo "WARN: git fetch failed"; exit 0; }
REMOTE=$(sudo -u gostork git rev-parse origin/main)
DEPLOYED=$(cat "$STATE" 2>/dev/null || echo none)
FORCE=${1:-}
if [ "$REMOTE" = "$DEPLOYED" ] && [ "$FORCE" != "--force" ]; then exit 0; fi
if [ -f "$FAILED" ] && [ "$FORCE" != "--force" ]; then
  read -r FSHA FTS < "$FAILED"
  if [ "$FSHA" = "$REMOTE" ] && [ $(( $(date +%s) - FTS )) -lt 900 ]; then exit 0; fi
fi
echo "deploying ${DEPLOYED:0:7} -> ${REMOTE:0:7}"
fail() { echo "WARN: deploy of ${REMOTE:0:7} FAILED at step: $1 - will retry in 15 min or on next push"; echo "$REMOTE $(date +%s)" > "$FAILED"; exit 1; }
sudo -u gostork git reset -q --hard origin/main || fail "git reset"
if ! sudo -u gostork bash -lc "cd $APP && npm ci --no-audit --no-fund" > /tmp/gostork-npm-ci.log 2>&1; then
  grep -v '^npm warn' /tmp/gostork-npm-ci.log | tail -8; fail "npm ci"
fi
sudo -u gostork bash -lc "cd $APP && npx prisma generate 2>&1 | tail -1" || fail "prisma generate"
sudo -u gostork bash -lc "cd $APP && npm run build 2>&1 | tail -4" || fail "npm run build"
# Schema: migration files are the contract (CLAUDE.md). _prisma_migrations baselined on prod 2026-08-18.
timeout 300 sudo -u gostork bash -lc "cd $APP && npx prisma migrate deploy 2>&1 | tail -3" || fail "prisma migrate deploy (timeout 300)"
systemctl restart gostork || fail "systemctl restart"
sleep 6
systemctl is-active --quiet gostork || fail "service not active after restart"
echo "$REMOTE" > "$STATE"; rm -f "$FAILED"
echo "deployed ${REMOTE:0:7}"
