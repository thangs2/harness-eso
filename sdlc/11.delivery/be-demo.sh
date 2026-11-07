#!/usr/bin/env bash
# BE demo — eso/control-plane (NestJS/Fastify). Stable entrypoint; batch is an argument.
# Usage: be-demo.sh [--batch=YYYY-MM-DD-eso-X-Y] [--check|--serve] [--no-build] [--port=N]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="--check"
BATCH=""
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --batch=*) BATCH="${arg#*=}" ;;
    --check|--serve) MODE="$arg" ;;
    -h|--help) echo "usage: $0 [--batch=YYYY-MM-DD-eso-X-Y] [--check|--serve] [--no-build] [--port=N]"; exit 0 ;;
    *) EXTRA+=("$arg") ;;
  esac
done
if [ -z "$BATCH" ]; then
  BATCH="$(ls -1 "$ROOT/sdlc/11.delivery/demo" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-' | sort | tail -1)"
fi
if [ ! -f "$ROOT/sdlc/11.delivery/demo/$BATCH/00.index.md" ]; then
  echo "unknown demo batch: $BATCH" >&2
  echo "available:" >&2
  ls -1 "$ROOT/sdlc/11.delivery/demo" | grep -E '^[0-9]{4}-' >&2 || true
  exit 2
fi
echo "[be-demo] batch=$BATCH mode=$MODE"
# The runner is a Bun script (`Bun.SQL`, D-93: PostgreSQL only); `node` dies at `new Bun.SQL`.
exec bun "$ROOT/scripts/demo-eso-v2.mjs" "$MODE" ${EXTRA[@]+"${EXTRA[@]}"}
