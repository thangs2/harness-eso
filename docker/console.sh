#!/usr/bin/env bash
# Harness Console — Docker stack (API + SPA on :8791)
#
#   console.sh build              host SPA verify + docker image build
#   console.sh up|start           compose up (-d); stops local dev on :8791 first
#   console.sh down|restart|status|health|logs
#
# Flags for up/start/restart: --no-build · --foreground (-f)
#
# Env: HARNESS_CONSOLE_PORT (8791) · HARNESS_AGENT_ROOT
#
# Examples:
#   ./docker/console.sh build && ./docker/console.sh up
#   ./docker/console.sh down
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$DOCKER_DIR/.." && pwd)"
CLI="$ESO_ROOT/packages/harness-cli/src/cli.mjs"

CONSOLE_PORT="${HARNESS_CONSOLE_PORT:-8791}"

die() { echo "console.sh: $*" >&2; exit 1; }

require_cli() {
    [[ -f "$CLI" ]] || die "missing $CLI — run from harness-eso clone"
    if [[ ! -d "$ESO_ROOT/node_modules" ]]; then
        die "missing node_modules — run: cd \"$ESO_ROOT\" && bun install"
    fi
}

run_console() {
    require_cli
    node "$CLI" console "$@"
}

stop_local_dev() {
    if command -v lsof >/dev/null 2>&1; then
        echo "==> stop local processes on :${CONSOLE_PORT} (console API / dev)"
        lsof -ti:"$CONSOLE_PORT" | xargs kill -9 2>/dev/null || true
    fi
    if command -v pkill >/dev/null 2>&1; then
        pkill -f "packages/harness-console-server/src/server.mjs" 2>/dev/null || true
        pkill -f "packages/harness-console/.*vite" 2>/dev/null || true
    fi
}

cmd_build() {
    if command -v bun >/dev/null 2>&1; then
        echo "==> bun run build:console (host verify)"
        (cd "$ESO_ROOT" && bun run build:console)
    else
        echo "==> skip host build (no bun); image build runs build:console inside Docker"
    fi
    echo "==> docker compose build (console image)"
    run_console build
}

cmd_up() {
    stop_local_dev
    local extra=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-build|--foreground|-f) extra+=("$1") ;;
            -h|--help) sed -n '3,14p' "$0" | sed 's/^# \?//'; exit 0 ;;
            *) die "unknown argument: $1" ;;
        esac
        shift
    done
    if ((${#extra[@]})); then run_console up "${extra[@]}"; else run_console up; fi
}

cmd_restart() {
    stop_local_dev
    run_console down
    cmd_up "$@"
}

main() {
    local cmd="${1:-help}"
    shift || true
    case "$cmd" in
        build) cmd_build "$@" ;;
        up|start) cmd_up "$@" ;;
        restart) cmd_restart "$@" ;;
        down|status|health|logs)
            run_console "$cmd" "$@"
            ;;
        ps) run_console status "$@" ;;
        dev)
            die "dev mode removed from console.sh — use Docker: console.sh up (or local: node packages/harness-console-server/src/server.mjs)"
            ;;
        help|-h|--help) sed -n '3,14p' "$0" | sed 's/^# \?//' ;;
        *) die "unknown command: $cmd (try: build up down restart status health logs)" ;;
    esac
}

main "$@"
