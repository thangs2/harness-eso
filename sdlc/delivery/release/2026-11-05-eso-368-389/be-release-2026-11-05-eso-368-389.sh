#!/usr/bin/env bash
# BE release gate — frozen install + 3 full runs + merge-block check.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
if [ -e MERGE_BLOCKED.md ]; then
  echo "MERGE_BLOCKED.md still open — release refused" >&2
  exit 1
fi
echo "[release] bun install --frozen-lockfile"
bun install --frozen-lockfile
for i in 1 2 3; do
  echo "[release] bun run test — run $i/3"
  bun run test
done
echo "[release] PASS — 3/3 green"
