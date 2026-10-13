#!/usr/bin/env bash
# [01] Observatory Docker — build image + compose up + health (bước 1)
set -euo pipefail
PROCESS_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$PROCESS_DIR/../.." && pwd)"

"$PROCESS_DIR/00.docker-check.sh"

cd "$ESO_ROOT"
export HARNESS_AGENT_ROOT="${HARNESS_AGENT_ROOT:-$HOME/Workspaces}"

PORT="${HARNESS_OBSERVE_PORT:-8792}"

echo "==> [01] observatory build"
./docker/observatory.sh build

echo "==> [01] harness up (default project from .harness/workspace.json)"
./harness up

echo "==> [01] GET http://127.0.0.1:${PORT}/health"
curl -fsS "http://127.0.0.1:${PORT}/health"
echo ""
echo "[01] OK — Observatory http://127.0.0.1:${PORT}/"
echo "[01] Next (new terminal): cd docker/process && ./02.console-up.sh"
