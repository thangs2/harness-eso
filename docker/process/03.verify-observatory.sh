#!/usr/bin/env bash
# [03] Verify Observatory API after init + IDE prompt (bước 3 check)
set -euo pipefail
PROCESS_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$PROCESS_DIR/../.." && pwd)"

PORT="${HARNESS_OBSERVE_PORT:-8792}"
BASE="http://127.0.0.1:${PORT}"

die() { echo "[03.verify-observatory] $*" >&2; exit 1; }

echo "==> [03] GET ${BASE}/health"
curl -fsS "${BASE}/health" || die "health failed — run ./01.observatory-up.sh first"
echo ""

echo "==> [03] GET ${BASE}/api/tenant"
curl -fsS "${BASE}/api/tenant" | head -c 400
echo ""
echo ""

echo "[03] OK — open ${BASE}/requests after a prompt on the consumer IDE."
echo "[03] Ingest: Status tab or wait for poll; transcript mount needs ~/.cursor in compose."
