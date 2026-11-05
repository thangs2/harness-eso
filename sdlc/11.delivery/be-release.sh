#!/usr/bin/env bash
# BE release gate — stable entrypoint; batch is an argument.
# Usage: be-release.sh [--batch=YYYY-MM-DD-eso-X-Y]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BATCH=""
for arg in "$@"; do
  case "$arg" in
    --batch=*) BATCH="${arg#*=}" ;;
    -h|--help) echo "usage: $0 [--batch=YYYY-MM-DD-eso-X-Y]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [ -z "$BATCH" ]; then
  BATCH="$(ls -1 "$ROOT/sdlc/11.delivery/release" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-' | sort | tail -1)"
fi
if [ ! -f "$ROOT/sdlc/11.delivery/release/$BATCH/00.index.md" ]; then
  echo "unknown release batch: $BATCH" >&2
  exit 2
fi
cd "$ROOT"
if [ -e MERGE_BLOCKED.md ]; then
  echo "MERGE_BLOCKED.md still open — release refused" >&2
  exit 1
fi
echo "[be-release] batch=$BATCH"
echo "[release] bun install --frozen-lockfile"
bun install --frozen-lockfile
for i in 1 2 3; do
  echo "[release] bun run test — run $i/3"
  bun run test
done
echo "[release] PASS — 3/3 green"
