#!/usr/bin/env bash
# Launch N copies of the compiled server on consecutive ports for parallel test sharding.
#
# All servers share the same Postgres DB (per .env) - Postgres handles the concurrent
# writes fine. Only the primary server (port 5001) is the one the dashboard / ngrok
# tunnel points at; the others are pure test workers.
#
# Usage:
#   scripts/start-test-servers.sh            # 3 servers on 5001, 5002, 5003
#   scripts/start-test-servers.sh 5          # 5 servers on 5001..5005
#   scripts/start-test-servers.sh stop       # kill all spawned test servers
#
# After starting, run the suite with:
#   TEST_SERVER_POOL="http://localhost:5001,http://localhost:5002,http://localhost:5003" \
#     npx tsx scripts/test-ai-concierge.ts
#
# Logs go to /tmp/server-PORT.log so they don't collide.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

ARG="${1:-3}"

if [[ "$ARG" == "stop" ]]; then
  echo "Stopping all spawned test servers (pkill -f 'node dist/index.cjs')..."
  pkill -f "node dist/index.cjs" 2>/dev/null || true
  sleep 1
  echo "Done."
  exit 0
fi

COUNT="$ARG"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]]; then
  echo "Usage: $0 [count|stop]"; exit 1
fi

# Stop any existing server processes first so ports are free.
echo "Stopping any existing servers..."
pkill -f "node dist/index.cjs" 2>/dev/null || true
sleep 2

# Make sure dist/index.cjs exists (build if not).
if [[ ! -f "dist/index.cjs" ]]; then
  echo "Building first (dist/index.cjs missing)..."
  npm run build > /dev/null
fi

# Launch one server per port.
#
# Ports are CLAIMED, not assumed. This used to walk 5001,5002,5003 blindly -
# but 5002 on the MacBook is nutrition-planner's `vite preview`, which answers
# 200 on / and so passed the old readiness check while being incapable of
# serving the concierge API. Every test sharded onto it died with "Lost server
# connection mid-response" and a 480s timeout, which reads exactly like a model
# or application regression. One 54-minute run (4 passed / 70 failed) was thrown
# away chasing that on 2026-08-25 before anyone looked at who owned the port.
#
# So: skip any port already held by someone else, and after starting, require
# that the port is held by the pid WE launched. A foreign 200 is not readiness.
URLS=()
PORT=5001
STARTED=0
while (( STARTED < COUNT )); do
  if (( PORT > 5100 )); then
    echo "ERROR: ran out of candidate ports below 5100 (started $STARTED of $COUNT)." >&2
    exit 1
  fi
  HOLDER="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [[ -n "$HOLDER" ]]; then
    WHO="$(ps -o command= -p "$HOLDER" 2>/dev/null | cut -c1-70)"
    echo "  - port $PORT already held by pid $HOLDER ($WHO) - skipping"
    PORT=$((PORT + 1))
    continue
  fi
  LOG="/tmp/server-${PORT}.log"
  echo "Starting server on port $PORT (log: $LOG)..."
  PORT="$PORT" nohup node dist/index.cjs > "$LOG" 2>&1 &
  SPAWNED=$!

  READY=0
  for t in $(seq 1 30); do
    sleep 1
    HOLDER="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    # The listener must be the process we just spawned (or its child), not a
    # squatter that happens to answer on this port.
    if [[ -n "$HOLDER" ]] && { [[ "$HOLDER" == "$SPAWNED" ]] || [[ "$(ps -o ppid= -p "$HOLDER" 2>/dev/null | tr -d ' ')" == "$SPAWNED" ]]; }; then
      echo "  ✓ Port $PORT ready (pid $HOLDER, ours)"
      READY=1
      break
    fi
    if ! kill -0 "$SPAWNED" 2>/dev/null; then
      echo "  ✗ Port $PORT: process died on startup - see $LOG" >&2
      break
    fi
  done

  if (( READY )); then
    URLS+=("http://localhost:${PORT}")
    STARTED=$((STARTED + 1))
  else
    echo "  ✗ Port $PORT did not come up as ours - skipping" >&2
  fi
  PORT=$((PORT + 1))
done

POOL="$(IFS=,; echo "${URLS[*]}")"
echo ""
echo "All $COUNT servers up. Use:"
echo ""
echo "  TEST_SERVER_POOL=\"$POOL\" \\"
echo "    npx tsx scripts/test-ai-concierge.ts"
echo ""
echo "To stop: scripts/start-test-servers.sh stop"
