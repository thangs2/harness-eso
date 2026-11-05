#!/usr/bin/env bash
# BE demo — eso/control-plane (NestJS/Fastify).
# Usage: be-demo-2026-11-05-eso-368-389.sh [--check|--serve] [--no-build] [--port=N]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
MODE="${1:---check}"
shift || true
case "$MODE" in
  --check) exec node "$ROOT/scripts/demo-eso-v2.mjs" --check "$@" ;;
  --serve) exec node "$ROOT/scripts/demo-eso-v2.mjs" --serve "$@" ;;
  *) echo "usage: $0 [--check|--serve] [--no-build] [--port=N]" >&2; exit 2 ;;
esac
