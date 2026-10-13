#!/usr/bin/env bash
# Harness Observatory — Docker stack (API + SPA on :8792)
#
#   observatory.sh build [flags]              host SPA verify + docker image build
#   observatory.sh up|start [consumer]      compose up (-d); optional consumer path → HARNESS_REPO_ROOT
#   observatory.sh down|restart|status|health|logs|smoke
#
# Flags for up/start/restart: --no-build · --foreground (-f)
#
# Env: HARNESS_REPO_ROOT · HARNESS_OBSERVE_PORT (8792) · HARNESS_CURSOR_HOME
#
# Examples:
#   export HARNESS_REPO_ROOT=~/Workspaces/x79
#   ./docker/observatory.sh build && ./docker/observatory.sh restart
#   ./docker/observatory.sh up ~/Workspaces/x79 --no-build
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$DOCKER_DIR/.." && pwd)"
CLI="$ESO_ROOT/packages/harness-cli/src/cli.mjs"

die() { echo "observatory.sh: $*" >&2; exit 1; }

require_cli() {
    [[ -f "$CLI" ]] || die "missing $CLI — run from harness-eso clone"
    if [[ ! -d "$ESO_ROOT/node_modules" ]]; then
        die "missing node_modules — run: cd \"$ESO_ROOT\" && bun install"
    fi
}

run_observatory() {
    require_cli
    node "$CLI" observatory "$@"
}

resolve_consumer() {
    local path="${1:-}"
    if [[ -z "$path" ]]; then
        return 0
    fi
    local abs
    abs="$(cd "$path" && pwd)"
    [[ -f "$abs/harness.config.json" ]] || die "no harness.config.json in $abs"
    export HARNESS_REPO_ROOT="$abs"
}

parse_consumer_and_flags() {
    consumer=""
    extra=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-build|--foreground|-f) extra+=("$1") ;;
            -h|--help) sed -n '3,15p' "$0" | sed 's/^# \?//'; exit 0 ;;
            -*) die "unknown flag: $1" ;;
            *)
                if [[ -z "$consumer" ]]; then consumer="$1"
                else extra+=("$1")
                fi
                ;;
        esac
        shift
    done
}

cmd_build() {
    if command -v bun >/dev/null 2>&1; then
        echo "==> bun run build:observatory (host verify)"
        (cd "$ESO_ROOT" && bun run build:observatory)
    else
        echo "==> skip host build (no bun); image build runs build:observatory inside Docker"
    fi
    echo "==> docker compose build (observatory image)"
    run_observatory build
}

cmd_up() {
    consumer=""
    extra=()
    parse_consumer_and_flags "$@"
    resolve_consumer "$consumer"
    if ((${#extra[@]})); then run_observatory up "${extra[@]}"; else run_observatory up; fi
}

cmd_restart() {
    consumer=""
    extra=()
    parse_consumer_and_flags "$@"
    resolve_consumer "$consumer"
    run_observatory down
    if ((${#extra[@]})); then run_observatory up "${extra[@]}"; else run_observatory up; fi
}

main() {
    local cmd="${1:-help}"
    shift || true
    case "$cmd" in
        build) cmd_build "$@" ;;
        up|start) cmd_up "$@" ;;
        restart) cmd_restart "$@" ;;
        down|status|health|logs|smoke)
            run_observatory "$cmd" "$@"
            ;;
        ps) run_observatory status "$@" ;;
        help|-h|--help) sed -n '3,15p' "$0" | sed 's/^# \?//' ;;
        *) die "unknown command: $cmd (try: build up down restart status health logs smoke)" ;;
    esac
}

main "$@"
