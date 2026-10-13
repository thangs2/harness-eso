#!/usr/bin/env bash
# [02] Harness Console — wizard init consumer (bước 2, Docker :8791)
set -euo pipefail
PROCESS_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$PROCESS_DIR/../.." && pwd)"

cd "$ESO_ROOT"

echo "==> [02] Console http://127.0.0.1:${HARNESS_CONSOLE_PORT:-8791}/"
echo "[02] Wizard: create/init project → provision consumer (x79)."
echo "[02] Requires bước 1 (Observatory :8792) already healthy."
echo ""

export HARNESS_AGENT_ROOT="${HARNESS_AGENT_ROOT:-$HOME/Workspaces}"
./docker/console.sh up "$@"
