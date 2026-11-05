#!/usr/bin/env bash
# FE demo — eso/ui (Angular build + structure + AC tests).
# No Angular dev server exists yet; this is build/typecheck/contract proof.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
echo "[fe] build eso/ui"
(cd "$ROOT/eso/ui" && npm run build)
echo "[fe] structure check"
node "$ROOT/eso/ui/scripts/check-structure.mjs"
echo "[fe] AC tests"
(cd "$ROOT" && bun test qc/eso-ui-*.test.mjs)
echo "[fe] PASS"
