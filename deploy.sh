#!/usr/bin/env bash
# Deploy / re-deploy the Observatory container for one consumer.
#
# Usage:
#   ./deploy.sh <consumer | all> [--no-build] [--smoke]
#
# Examples:
#   ./deploy.sh x79 --plan    # resolve the consumer and open port, print the steps, do nothing
#   ./deploy.sh x79           # build the SPA + image, then (re)start that consumer's stack
#   ./deploy.sh all --no-build
#
# Exit codes:
#   0  deployed and healthy (or the --plan report printed)
#   1  build, start, or health check failed
#   2  usage error, or an unknown consumer
#
# This script is one of the four operator entrypoints (deploy.sh, provision.sh, verify-consumer.sh,
# console.sh). It resolves the consumer, then hands the runtime work to `harness-cli observatory`:
# the compose stack is keyed by project id, so the identity of a deployment is the consumer, never the
# port. Keep build/start behaviour in the CLI and liveness evidence here — duplicating either creates
# a second definition of "deployed".
set -euo pipefail

# `sh deploy.sh x79` is a documented invocation; re-exec under bash once.
if [ -z "${BASH_VERSION:-}" ]; then
    # Do not hardcode /bin/bash: Git Bash on Windows has no such path. Prefer bash from PATH, then
    # /bin/bash for the platforms that do have it, and fail with a sentence rather than exec 127.
    if command -v bash >/dev/null 2>&1; then
        exec bash "$0" "$@"
    fi
    # Last resort: the conventional absolute paths, tried one at a time. Never `exec /bin/bash`
    # directly — on Windows that line *is* the bug this block exists to fix.
    for _harness_bash in /bin/bash /usr/local/bin/bash /opt/homebrew/bin/bash; do
        if [ -x "$_harness_bash" ]; then
            exec "$_harness_bash" "$0" "$@"
        fi
    done
    echo "${0}: bash is required (this script uses bash-only syntax) and none was found on PATH" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

die() {
    echo "❌ deploy.sh: $*" >&2
    exit 1
}

usage() {
    cat <<EOF
Usage: ./deploy.sh <consumer | all> [--plan] [--no-build] [--smoke]

  --plan       resolve the consumer, print what would happen, touch nothing
  --no-build   skip the SPA + image build (use the image already tagged locally)
  --smoke      run the CLI smoke check after the stack reports healthy

Exit: 0 deployed · 1 failure · 2 usage error or unknown consumer
EOF
}

# Every project in the registry, one line each: mark, id, port, status, root.
#
# Read through the registry module, not through `node -e` + string concatenation: the port moved from
# `p.port` to `p.observe.port` in registry v2, and a hand-built expression printed `undefined` while
# the script went on to deploy against port `undefined`.
registry_rows() {
    node --input-type=module -e '
import { loadWorkspace } from "@mu/harness-foundation/workspace";
const ws = loadWorkspace();
for (const p of ws.projects || []) {
    const port = p.observe?.port ?? p.port ?? "";
    const root = p.rootHost || p.root || "";
    const status = p.status || "draft";
    const mark = p.id === ws.defaultProjectId ? "*" : " ";
    process.stdout.write([mark, p.id, port === "" ? "-" : port, status, root].join("\t") + "\n");
}
' 2>/dev/null || true
}

list_consumers() {
    echo "Registered consumers:"
    local rows
    rows=$(registry_rows)
    if [[ -z "$rows" ]]; then
        echo "  (none)"
        return
    fi
    while IFS=$'\t' read -r mark id port status root; do
        [[ -z "$id" ]] && continue
        printf '  %s %-16s :%-6s %-12s %s\n' "$mark" "$id" "$port" "$status" "$root"
    done <<< "$rows"
    echo "  (* = default project)   all = every consumer above"
}

# Resolve one consumer id to "id<TAB>port<TAB>root". Exit 2 when unknown, 1 when it has no port —
# the two need different fixes, so they need different codes.
resolve_consumer() {
    local wanted="$1"
    local rows line
    rows=$(registry_rows)
    line=$(printf '%s\n' "$rows" | awk -F'\t' -v id="$wanted" '$2 == id { print; exit }')
    if [[ -z "$line" ]]; then
        echo "❌ Unknown consumer: '$wanted' — it is not in the registry." >&2
        list_consumers >&2
        return 2
    fi
    local port root
    port=$(printf '%s' "$line" | cut -f3)
    root=$(printf '%s' "$line" | cut -f5)
    if [[ -z "$port" || "$port" == "-" ]]; then
        echo "❌ Consumer '$wanted' has no observe port in the registry." >&2
        echo "   Assign one:  ./console.sh up  →  Projects → open '$wanted'" >&2
        return 1
    fi
    printf '%s\t%s\t%s\n' "$wanted" "$port" "$root"
}

require_docker() {
    command -v docker >/dev/null 2>&1 || die "Docker Desktop / Engine is not installed"
    docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
    docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop / Engine"
}

# The image build runs `bun install --frozen-lockfile`, so a workspace package added without
# refreshing bun.lock fails only after the SPA has already been built.
check_lockfile() {
    echo "🔒 [0/3] Checking bun.lock against the workspace..."
    bun install --frozen-lockfile >/dev/null 2>&1 ||
        die "bun.lock is out of date (new workspace package?) — run: bun install, then deploy again"
}

# DSH sessions and the gate trail live outside the consumer. Without these mounts the container looks
# healthy while every DSH session is invisible — the exact failure this check exists to catch.
verify_extra_spines() {
    local port="$1"
    local status
    status=$(curl -fsS "http://127.0.0.1:${port}/api/ingest/status" 2>/dev/null || true)
    if [[ -z "$status" ]]; then
        echo "⚠️  could not read /api/ingest/status on :$port"
        return 0
    fi
    node --input-type=module -e '
const s = JSON.parse(process.argv[1]);
const dsh = s.dsh || {};
const gate = s.gate || {};
console.log(`   DSH:   sessions=${dsh.sessions ?? 0}  dirs=${(dsh.dirs || []).join(",") || "—"}  exists=${dsh.dirsExist}`);
console.log(`   Gate:  lines=${gate.lines ?? 0}  ${gate.trailPath || "—"}`);
if (!dsh.dirsExist) console.log("   ⚠️  no DSH directory found — check the ~/.dsh → /host-dsh mount");
else if ((dsh.sessions ?? 0) === 0) console.log("   ⚠️  mounted but 0 sessions for this workspace — check the slug (--Users-…-repo--)");
' "$status"
}

build_images() {
    if [[ "$do_build" != "true" ]]; then
        echo "⏩ Skipping the image build (--no-build)"
        return 0
    fi
    echo "=================================================="
    echo "🔨 [1/3] Building the Observatory SPA"
    echo "=================================================="
    (cd "$ROOT" && bun run build:observatory)

    echo ""
    echo "=================================================="
    echo "🐳 [2/3] Building the image (mu/harness-observe:local)"
    echo "=================================================="
    node "$CLI" observatory build
}

deploy_single_consumer() {
    local proj_id="$1"
    local resolved
    resolved=$(resolve_consumer "$proj_id") || return $?
    local id port root
    IFS=$'\t' read -r id port root <<< "$resolved"

    echo ""
    echo "=================================================="
    echo "🚀 Consumer: $id  (port :$port)"
    echo "   Compose stack: harness-observatory-$id"
    echo "   Repo root:     $root"
    echo "=================================================="

    if [[ "$do_plan" == "true" ]]; then
        echo "DRY RUN — would run:"
        [[ "$do_build" == "true" ]] && echo "  - bun run build:observatory"
        [[ "$do_build" == "true" ]] && echo "  - node <cli> observatory build"
        echo "  - node <cli> observatory restart --project $id"
        echo "  - GET http://127.0.0.1:$port/health, then /api/tenant must report \"$id\""
        [[ "$do_smoke" == "true" ]] && echo "  - node <cli> observatory smoke"
        return 0
    fi

    # The stack is keyed by project id, never by port: a port is an entrance and the id is the
    # identity. Keying by port is what let `restart` of one project take down another's stack.
    node "$CLI" observatory restart --project "$id"

    echo ""
    echo "⏳ Waiting for the container on :$port..."
    local ok=false
    for _ in {1..15}; do
        if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
            ok=true
            break
        fi
        sleep 1
    done

    if [[ "$ok" != "true" ]]; then
        echo "⚠️  The container started but /health has not answered on :$port. Logs:"
        HARNESS_OBSERVE_PORT="$port" node "$CLI" observatory logs || true
        return 1
    fi

    # A healthy container is not proof that it serves *this* consumer: the port may be held by another
    # project's stack, and `/health` answers 200 either way. Ask the tenant endpoint which project the
    # stack is configured for.
    local served
    served=$(curl -fsS "http://127.0.0.1:${port}/api/tenant" 2>/dev/null || true)
    if [[ -n "$served" ]] && ! printf '%s' "$served" | grep -q "\"$id\""; then
        echo "❌ The stack on :$port is NOT '$id' — another consumer holds the port."
        echo "   /api/tenant returned: $served"
        echo "   Fix: ./console.sh verify   (shows which project owns :$port)"
        return 1
    fi

    echo "✅ Consumer '$id' is serving: http://127.0.0.1:${port}/"
    echo ""
    echo "🔎 Ingest spine (Cursor / DSH / gate trail):"
    curl -fsS -X POST "http://127.0.0.1:${port}/api/ingest/run?force=1" >/dev/null 2>&1 || true
    verify_extra_spines "$port"

    if [[ "$do_smoke" == "true" ]]; then
        echo ""
        echo "🧪 Smoke check on :$port..."
        HARNESS_OBSERVE_PORT="$port" node "$CLI" observatory smoke
    fi
    return 0
}

do_build=true
do_smoke=false
do_plan=false
target_consumer=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan)
            do_plan=true
            ;;
        --no-build)
            do_build=false
            ;;
        --smoke)
            do_smoke=true
            ;;
        -h | --help | help)
            usage
            echo ""
            list_consumers
            exit 0
            ;;
        -*)
            die "invalid flag: $1"
            ;;
        *)
            if [[ -z "$target_consumer" ]]; then
                target_consumer="$1"
            else
                die "only one consumer at a time (got: $target_consumer, $1)"
            fi
            ;;
    esac
    shift
done

if [[ -z "$target_consumer" ]]; then
    echo "⚠️  No consumer given."
    usage
    echo ""
    list_consumers
    exit 2
fi

# Resolve before touching Docker: an unknown consumer should be a one-line answer, not a build that
# runs for two minutes and then fails.
if [[ "$target_consumer" != "all" ]]; then
    rc=0
    resolved=$(resolve_consumer "$target_consumer") || rc=$?
    if ((rc != 0)); then
        exit "$rc"
    fi
fi

# --plan writes nothing at all — not even the image: a dry run that rebuilds is not a dry run.
if [[ "$do_plan" != "true" ]]; then
    require_docker
    check_lockfile
    build_images
fi

failed=0
if [[ "$target_consumer" == "all" ]]; then
    echo ""
    echo "=================================================="
    echo "🔄 Re-deploying every registered consumer"
    echo "=================================================="
    while IFS=$'\t' read -r _mark id _port _status _root; do
        [[ -z "$id" ]] && continue
        deploy_single_consumer "$id" || failed=$((failed + 1))
    done <<< "$(registry_rows)"
else
    rc=0
    deploy_single_consumer "$target_consumer" || rc=$?
    ((rc == 0)) || failed=$((failed + 1))
fi

echo ""
if ((failed > 0)); then
    echo "❌ deploy finished with ${failed} failure(s)" >&2
    exit 1
fi
if [[ "$do_plan" == "true" ]]; then
    echo "🎉 Dry run complete — nothing was started"
else
    echo "🎉 Deploy complete"
fi
