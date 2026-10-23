#!/usr/bin/env bash
# Local Observatory dev: observe API + Vite HMR on :5190
#
# Consumer = repo có harness.config.json (ESO project).
# Default consumer: sibling ../x79 (standard harness-eso dev). Do NOT point here unless you mean it.
#
# Observe state (harness.db + blobs) does NOT live in the consumer repo: it goes to
# HARNESS_DATA_ROOT=<root>/<projectId>/, same layout Docker uses. A dev loop that wrote a
# 28MB+ DB (plus WAL/SHM siblings) into the consumer working tree kept two divergent copies
# of the same project and scattered state across every consumer on disk.
#
# Usage:
#   ./scripts/dev-observe.sh                    # → ../x79 when harness.config.json exists
#   ./scripts/dev-observe.sh ~/Workspaces/x79
#   HARNESS_REPO_ROOT=~/Workspaces/x79 ./scripts/dev-observe.sh
#
# UI:  http://127.0.0.1:5190/requests
# API: http://127.0.0.1:${HARNESS_OBSERVE_PORT:-8792} (proxied as /api)
#
# If something already listens on the observe port, only Vite starts — stop that server first
# if it was started with a different --root (wrong project).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSUMER="${1:-${HARNESS_REPO_ROOT:-}}"
PORT="${HARNESS_OBSERVE_PORT:-8792}"

if [[ -z "$CONSUMER" ]]; then
  if [[ -f "$ROOT/../x79/harness.config.json" ]]; then
    CONSUMER="$(cd "$ROOT/../x79" && pwd)"
  else
    echo "dev-observe.sh: set consumer path or HARNESS_REPO_ROOT (repo with harness.config.json)" >&2
    exit 1
  fi
fi
CONSUMER="$(cd "$CONSUMER" && pwd)"

if [[ ! -f "$CONSUMER/harness.config.json" ]]; then
  echo "dev-observe.sh: no harness.config.json in $CONSUMER" >&2
  exit 1
fi

export HARNESS_OBSERVE_URL="http://127.0.0.1:${PORT}"

# Observe state root — one shared home for every project's DB, outside each consumer repo.
# Resolved per project by the server: ${HARNESS_DATA_ROOT}/<project.id>/harness.db.
# Override the root itself with HARNESS_DATA_ROOT=... ; override the file with
# HARNESS_SQLITE_PATH=... (see packages/harness-observe-server/src/observe-config.mjs).
export HARNESS_DATA_ROOT="${HARNESS_DATA_ROOT:-$HOME/.harness/observe}"

# Dev defaults: UI stays responsive; run ingest manually from Status if needed.
export HARNESS_INGEST_POLL_MS="${HARNESS_INGEST_POLL_MS:-15000}"
export HARNESS_INGEST_DEFER_MS="${HARNESS_INGEST_DEFER_MS:-8000}"
# Backfills walk history so the ledger (evidence + decisions) converges instead of only
# covering turns ingested after the feature was enabled. Both default to 0 in dev to keep a
# poll cheap — which also means a dev DB has EMPTY Evidence/consent panels and no green path
# until you either raise these or run a one-off ingest with them set.
export HARNESS_ESO_BACKFILL_LIMIT="${HARNESS_ESO_BACKFILL_LIMIT:-0}"
export HARNESS_FACADE_BACKFILL_LIMIT="${HARNESS_FACADE_BACKFILL_LIMIT:-0}"

SERVER_PID=""
STARTED_SERVER=0
cleanup() {
  if [[ "$STARTED_SERVER" == 1 && -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  HEALTH_JSON="$(curl -sf "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  if [[ "$HEALTH_JSON" == *"/data/observe"* ]]; then
    echo "dev-observe.sh: Docker Observatory is on :${PORT} (DB on volume /data/observe)." >&2
    echo "  Stop it first: ./deploy.sh down  — or use another HARNESS_OBSERVE_PORT." >&2
    exit 1
  fi
  echo "==> observe API already up on :${PORT} (reusing — must match consumer $CONSUMER or stop it first)"
else
  echo "==> observe-server project: $CONSUMER"
  echo "==> observe-server --root $CONSUMER (port $PORT)"
  node "$ROOT/packages/harness-observe-server/src/server.mjs" --root "$CONSUMER" --port "$PORT" &
  SERVER_PID=$!
  STARTED_SERVER=1
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "dev-observe.sh: observe-server did not become healthy on :${PORT}" >&2
    exit 1
  fi
fi

echo "==> Vite dev (proxy → $HARNESS_OBSERVE_URL)"
echo "    Open http://127.0.0.1:${HARNESS_OBSERVATORY_DEV_PORT:-5190}/requests"
cd "$ROOT"
exec bun run dev:observatory
