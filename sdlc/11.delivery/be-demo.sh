#!/usr/bin/env bash
# BE demo — eso/control-plane (NestJS/Fastify). Stable entrypoint; batch is an argument.
# Usage: be-demo.sh [--batch=YYYY-MM-DD-eso-X-Y] [--check|--serve] [--no-build] [--port=N]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="--check"
BATCH=""
CONSUMER=""
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --batch=*) BATCH="${arg#*=}" ;;
    --consumer=*) CONSUMER="${arg#*=}" ;;
    --check|--serve) MODE="$arg" ;;
    -h|--help) echo "usage: $0 [--batch=YYYY-MM-DD-eso-X-Y] [--check|--serve] [--no-build] [--port=N] [--consumer=<id>]"; exit 0 ;;
    *) EXTRA+=("$arg") ;;
  esac
done

if [ -n "$CONSUMER" ]; then
  CHECK_PROVISION=$(node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const consumerId = process.argv[1];
    const stateDir = process.env.HARNESS_PRODUCT_STATE_DIR || path.join(process.env.HOME || "", ".harness");
    const wsFile = path.join(stateDir, "workspace.json");
    if (!fs.existsSync(wsFile)) process.exit(1);
    try {
      const ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
      const p = (ws.projects || []).find((x) => x.id === consumerId);
      if (!p || !p.root) process.exit(1);
      const cfgFile = path.join(p.root, "harness.config.json");
      if (!fs.existsSync(cfgFile)) process.exit(1);
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      if (!cfg.storage || !cfg.storage.graph) process.exit(1);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$CONSUMER" && echo "ok" || echo "fail")

  if [ "$CHECK_PROVISION" != "ok" ]; then
    echo "❌ Consumer \x27$CONSUMER\x27 has not been provisioned with graph storage (storage.graph missing)." >&2
    echo "   → Run: ./provision.sh $CONSUMER" >&2
    exit 1
  fi
  EXTRA+=("--consumer=$CONSUMER")
fi
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
