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
URLS=()
for ((i=0; i<COUNT; i++)); do
  PORT=$((5001 + i))
  LOG="/tmp/server-${PORT}.log"
  echo "Starting server on port $PORT (log: $LOG)..."
  PORT="$PORT" nohup node dist/index.cjs > "$LOG" 2>&1 &
  URLS+=("http://localhost:${PORT}")
done

# Wait for each port to start serving (10s each at most).
sleep 3
for ((i=0; i<COUNT; i++)); do
  PORT=$((5001 + i))
  for t in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sI "http://localhost:${PORT}/" >/dev/null 2>&1; then
      echo "  ✓ Port $PORT ready"
      break
    fi
    sleep 1
  done
done

POOL="$(IFS=,; echo "${URLS[*]}")"
echo ""
echo "All $COUNT servers up. Use:"
echo ""
echo "  TEST_SERVER_POOL=\"$POOL\" \\"
echo "    npx tsx scripts/test-ai-concierge.ts"
echo ""
echo "To stop: scripts/start-test-servers.sh stop"
