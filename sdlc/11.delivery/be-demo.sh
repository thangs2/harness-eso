#!/usr/bin/env bash
# BE demo — eso/control-plane (NestJS/Fastify). Stable entrypoint; batch is an argument.
# Usage: be-demo.sh --consumer=<id> [--batch=YYYY-MM-DD-eso-X-Y] [--check|--serve] [--no-build] [--port=N]
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

# D-105 #6: the demo is consumer-scoped. There is no env fallback — a database URL in the operator's
# environment must not be able to start a demo that no consumer owns.
if [ -z "$CONSUMER" ]; then
  echo "❌ be-demo.sh requires --consumer=<id>: the demo reads that consumer's storage.graph." >&2
  echo "   → Run: ./provision.sh <id>   then: sdlc/11.delivery/be-demo.sh --consumer=<id>" >&2
  exit 2
fi

# Build the DSN from the consumer's own provisioned state: storage.graph is the address (no secret),
# and `<root>/.harness/graph.connection` is the plain PostgreSQL DSN (BIP 61 §3). The wrapper passes
# the DSN on argv; the runner never reads ESO_DEMO_DB_URL or any other environment fallback.
DB_URL=""
if ! DB_URL="$(node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const consumerId = process.argv[1];
    const stateDir = process.env.HARNESS_PRODUCT_STATE_DIR || path.join(process.env.HOME || "", ".harness");
    const fail = (message) => {
      console.error(`be-demo: ${message}`);
      process.exit(1);
    };
    const wsFile = path.join(stateDir, "workspace.json");
    if (!fs.existsSync(wsFile)) fail(`consumer ${consumerId} is not in the workspace registry (${wsFile})`);
    let ws;
    try {
      ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
    } catch {
      fail(`workspace registry is not JSON: ${wsFile}`);
    }
    const project = (ws.projects || []).find((entry) => entry.id === consumerId);
    if (!project || !project.root) fail(`consumer ${consumerId} has no root in the workspace registry`);

    const cfgFile = path.join(project.root, "harness.config.json");
    if (!fs.existsSync(cfgFile)) fail(`consumer ${consumerId} has no harness.config.json — run ./provision.sh ${consumerId}`);
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    } catch {
      fail(`harness.config.json is not JSON: ${cfgFile}`);
    }
    const graph = cfg.storage && cfg.storage.graph;
    if (!graph) fail(`consumer ${consumerId} has no storage.graph — run ./provision.sh ${consumerId}`);

    const secretFile = path.join(project.root, ".harness", "graph.connection");
    if (!fs.existsSync(secretFile)) fail(`consumer ${consumerId} has no .harness/graph.connection — run ./provision.sh ${consumerId}`);
    const dsn = fs.readFileSync(secretFile, "utf8").trim();
    if (!dsn) fail(`consumer ${consumerId} has an empty .harness/graph.connection`);

    let parsed;
    try {
      parsed = new URL(dsn);
    } catch {
      fail(`consumer ${consumerId} .harness/graph.connection is not a PostgreSQL URL`);
    }
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
      fail(`consumer ${consumerId} secret is not a PostgreSQL URL (${parsed.protocol})`);
    }
    const secretDatabase = parsed.pathname.replace(/^\//, "");
    const secretPort = parsed.port ? Number(parsed.port) : 5432;
    const expectedPort = Number(graph.port);
    if (parsed.hostname !== graph.host || secretPort !== expectedPort || secretDatabase !== graph.database) {
      fail(`consumer ${consumerId} secret DSN does not match storage.graph (${graph.host}:${graph.port}/${graph.database}) — run ./provision.sh ${consumerId}`);
    }
    process.stdout.write(dsn);
  ' "$CONSUMER")"; then
  echo "   → Run: ./provision.sh $CONSUMER" >&2
  exit 1
fi

EXTRA+=("--consumer=$CONSUMER" "--db-url=$DB_URL")
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
