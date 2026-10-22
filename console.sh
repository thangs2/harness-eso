#!/usr/bin/env bash
# Deploy / re-deploy the Harness Console ():8791 — the surface that manages every consumer profile.
#
# Usage:
#   ./console.sh [up|restart|down|status|health|logs|build|verify|smoke] [--no-build] [--no-browser]
#
# Examples:
#   ./console.sh                     # = up: preflight + build (if needed) + start + verify
#   ./console.sh verify              # check :8791 only, never touches Docker
#   ./console.sh restart --no-build  # change a bind mount / product state without rebuilding the image
#   ./console.sh down                # stop the harness-console-8791 stack
#
# Design notes (read before editing):
#
#   1. The Console is ONE server for N profiles. It has no per-consumer port; each profile owns its
#      Observatory port in `~/.harness/workspace.json`. So this script cares about exactly one port,
#      :8791. Per-project probing goes through `/api/projects/<id>/observe-health` — never hard-code
#      :8792 here.
#
#   2. "Container running" does NOT mean "Console correct". Three things were once wrong while still
#      healthy: product state mounted from the wrong path (0 projects), agent root mounted empty
#      (wizard sees no repo), and observe probes pinned to one port. `verify` checks all three
#      against real data.
#
#   3. Stack identity = `harness-console-<port>` (set in `packages/harness-cli/src/console-cmd.mjs`).
#      The Console is one instance per host, so the port is a reasonable identity here — unlike the
#      Observatory, where N projects share one image and identity must be the project id.
#
#   4. Every message is English. The operator reading this is often the one who cannot read the
#      error twice, and mixed-language output makes a diff between two hosts unreadable.
set -euo pipefail

# [/]: this script uses [[ ]] and BASH_SOURCE-free `local`. Run under whatever interpreter invoked it
# (`sh console.sh` is common and works on macOS, but `sh` is dash elsewhere). Re-exec under bash
# once, keeping the same argv, so the operator does not have to know.
if [ -z "${BASH_VERSION:-}" ]; then
    exec /bin/bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"
SELF="$ROOT/$(basename "$0")"

CONSOLE_PORT="${HARNESS_CONSOLE_PORT:-8791}"

# Defaults are resolved here rather than left to compose: a bare `docker compose up` outside this
# script otherwise dies on a required variable that this script is responsible for providing.
export HARNESS_CONSOLE_PORT
export HARNESS_PRODUCT_STATE_HOST="${HARNESS_PRODUCT_STATE_HOST:-$HOME/.harness}"
export HARNESS_AGENT_ROOT="${HARNESS_AGENT_ROOT:-$HOME/Workspaces}"
export HARNESS_CURSOR_HOME="${HARNESS_CURSOR_HOME:-$HOME/.cursor}"
export HARNESS_GEMINI_HOME="${HARNESS_GEMINI_HOME:-$HOME/.gemini}"

PRODUCT_STATE_HOST="$HARNESS_PRODUCT_STATE_HOST"
AGENT_ROOT="$HARNESS_AGENT_ROOT"
STACK="harness-console-${CONSOLE_PORT}"

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok() { printf '   \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
note() { printf '     %s\n' "$*"; }
die() {
    printf '\033[31m ✘ console.sh: %s\033[0m\n' "$*" >&2
    exit 1
}

require_docker() {
    command -v docker >/dev/null 2>&1 || die "Docker Desktop / Engine is not installed (docker not on PATH)"
    docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (got: $(docker compose version 2>&1 | head -1))"
    docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop / Engine"
}

json_field() {
    # $1 = file holding JSON (`-` reads stdin), $2 = JS expression evaluated with `j` bound to the
    # parsed object. Two arguments by construction: a pipeline `… | json_field "$(cat)"` was the
    # version that silently passed an empty string.
    HARNESS_JSON_EXPR="$2" node -e '
const fs = require("node:fs");
const file = process.argv[1];
const raw = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
const j = JSON.parse(raw);
const fn = new Function("j", process.env.HARNESS_JSON_EXPR);
const out = fn(j);
process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
' "$1"
}

# Same helper for a JSON document already in a shell variable, without a temp file.
json_var() {
    printf '%s' "$1" | json_field /dev/stdin "$2"
}

# ---------------------------------------------------------------------------------------------------
# State probes. `verify` must explain the operator's actual situation, and "nothing listening" is
# three different situations: never deployed, deployed but stopped, deployed and starting.
# ---------------------------------------------------------------------------------------------------
daemon_up() { docker info >/dev/null 2>&1; }

console_image_exists() { docker image inspect mu/harness-console:local >/dev/null 2>&1; }

console_container_state() {
    # Prints running | exited | created | missing. Never fails: `docker ps` returning nothing is a
    # legitimate answer here, and `set -e` would otherwise turn it into a script exit.
    docker ps -a --filter "name=^/${STACK}-" --format '{{.State}}' 2>/dev/null | head -1 || true
}

port_listener() {
    lsof -nP -iTCP:"${CONSOLE_PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}' || true
}

# Why :8791 does not answer yet. Used by both verify and up so the diagnosis cannot drift between them.
diagnose_no_answer() {
    if ! daemon_up; then
        note "the Docker daemon is not running"
        note "→ start Docker Desktop / Engine, then: ./console.sh up"
        return
    fi
    local state
    state=$(console_container_state)
    case "$state" in
        running)
            note "container ${STACK} is running but not serving /health yet"
            note "→ if it stays this way: ./console.sh logs"
            ;;
        exited | created)
            note "container ${STACK} exists in state '${state}' but is not serving /health"
            note "→ ./console.sh logs   (then ./console.sh restart)"
            ;;
        *)
            local holder
            holder=$(port_listener)
            if [[ -n "$holder" ]]; then
                note ":${CONSOLE_PORT} is held by ${holder}, which is not a Console container"
                note "→ stop it, or run with HARNESS_CONSOLE_PORT=<free port>"
                return
            fi
            if console_image_exists; then
                note "the image mu/harness-console:local exists but nothing is deployed"
            else
                note "the image mu/harness-console:local does not exist — nothing has been built"
            fi
            note "→ ./console.sh up        (preflight, build, start, verify)"
            ;;
    esac
}

# ---------------------------------------------------------------------------------------------------
# verify — the gate. Runs without Docker so it can also be pointed at a dev server (`bun run dev`).
# ---------------------------------------------------------------------------------------------------
cmd_verify() {
    local base="http://127.0.0.1:${CONSOLE_PORT}"
    local wait="${CONSOLE_WAIT_SECONDS:-60}"

    step "[1/5] HTTP on :${CONSOLE_PORT}"

    # Not deployed is not a timeout. Waiting 60s to say "never built" wastes the operator's minute
    # and hides the one fact that determines the next command.
    if ! curl -fsS --max-time 2 "${base}/health" >/dev/null 2>&1; then
        local state="missing"
        if daemon_up; then state=$(console_container_state); fi
        if [[ "$state" != "running" ]]; then
            warn "nothing is serving on :${CONSOLE_PORT}"
            diagnose_no_answer
            die "Console is not deployed — the checks after this one were not run"
        fi

        # A container that is up but not answering is a startup race, not a missing deploy.
        local waited=0
        printf '   waiting for a starting container (up to %ss)…\n' "$wait"
        while ! curl -fsS --max-time 2 "${base}/health" >/dev/null 2>&1; do
            if [[ "$waited" -ge "$wait" ]]; then
                warn "container ${STACK} is running but /health did not answer in ${waited}s"
                note "→ ./console.sh logs"
                die "the container is up; the server inside it is not"
            fi
            sleep 1
            waited=$((waited + 1))
        done
    fi

    local health
    health=$(curl -fsS "${base}/health")
    ok "/health answered: $(json_var "$health" 'return `port=${j.port} service=${j.service}`')"

    step "[2/5] The listener is the Console, not an Observatory"
    local port_owner
    port_owner=$(json_var "$health" 'return j.service === "harness-console" ? "console" : "other"')
    [[ "$port_owner" == "console" ]] ||
        die ":${CONSOLE_PORT} answered with service=$(json_var "$health" 'return j.service || "?"') — an Observatory is bound to the Console port?"
    ok "service=harness-console"

    step "[3/5] Product state — the Console reads the host registry"
    local meta
    meta=$(curl -fsS "${base}/api/meta") || die "GET /api/meta failed — the server is up but misbehaving; see ./console.sh logs"
    local state_dir projects_dir
    state_dir=$(json_var "$meta" 'return j.productStateDir')
    projects_dir=$(json_var "$meta" 'return j.projectsDir')
    ok "in-container product state: ${state_dir}"
    ok "projects read from:         ${projects_dir}"
    # The mount is the check: a fresh/empty volume still answers 200 with zero projects, which looks
    # exactly like "host has no projects yet". Compare against the host registry instead of guessing.
    local host_count=0
    if [[ -f "${PRODUCT_STATE_HOST}/workspace.json" ]]; then
        host_count=$(node -e '
const fs = require("node:fs");
const ws = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log((ws.projects || []).length);
' "${PRODUCT_STATE_HOST}/workspace.json")
    fi
    # A route that does not exist is a stale image, not a broken registry. `curl -f` inside a pipe
    # used to hand an empty string to json_field, which died with a SyntaxError that named neither
    # the route nor the image.
    local ports_json
    ports_json=$(curl -sS -w '\n%{http_code}' --max-time 5 "${base}/api/observe-ports" 2>/dev/null || true)
    local ports_code="${ports_json##*$'\n'}"
    ports_json="${ports_json%$'\n'*}"
    if [[ "$ports_code" != "200" ]]; then
        warn "GET /api/observe-ports → ${ports_code}"
        note "the route is missing from this image, so the running server predates the source"
        note "→ ./console.sh          (build + deploy the current source)"
        die "the deployed image is stale — routes after this one cannot be checked"
    fi
    local seen_count
    seen_count=$(json_var "$ports_json" 'return j.items.length')
    ok "host registry: ${host_count} project(s) · console sees: ${seen_count}"
    if [[ "$seen_count" != "$host_count" ]]; then
        die "the Console sees ${seen_count}/${host_count} project(s) — the mount ${PRODUCT_STATE_HOST} → ${state_dir} is wrong, or the volume is stale"
    fi

    step "[4/5] Agent repos — the wizard can see a host directory"
    local agent_default
    agent_default=$(json_var "$meta" 'return j.agentRootDefault || ""')
    ok "agentRootDefault: ${agent_default:-(empty)}"
    [[ -n "$agent_default" ]] || die "agentRootDefault is empty — HARNESS_AGENT_ROOT is not set (current: ${AGENT_ROOT})"

    step "[5/5] Each profile probes its own Observatory"
    local rows
    rows=$(curl -fsS "${base}/api/observe-ports")
    local ids
    ids=$(json_var "$rows" 'return j.items.map((i) => `${i.id}:${i.port}`).join(" ")')
    if [[ -z "$ids" ]]; then
        warn "no projects registered — :${CONSOLE_PORT} is a valid Console, add a consumer in the UI"
        note "→ http://127.0.0.1:${CONSOLE_PORT}/ → Projects → add, then ./deploy.sh <id>"
    else
        for pair in $ids; do
            local id="${pair%%:*}"
            local port="${pair##*:}"
            local resp
            resp=$(curl -sS --max-time 5 "${base}/api/projects/${id}/observe-health" 2>/dev/null || true)
            if [[ -z "$resp" ]]; then
                warn "${id} (:${port}) — probe failed, the Console did not answer the health route"
                continue
            fi
            local reachable
            reachable=$(json_var "$resp" 'return j.ok === true ? "up" : "down"')
            if [[ "$reachable" == "up" ]]; then
                ok "${id} (:${port}) → Observatory up"
            else
                # Expected topology when only the console is being validated: this is a report,
                # not a failure. `./deploy.sh <id>` is the step that makes it green.
                warn "${id} (:${port}) → Observatory not deployed yet"
                note "→ ./deploy.sh ${id}"
            fi
        done
    fi

    printf '\n\033[1;32mConsole verified\033[0m → %s/\n' "$base"
}

# ---------------------------------------------------------------------------------------------------
# smoke — behaviour, not topology. Creates nothing; only reads and exercises the API surface the UI
# depends on, so a broken route is caught before a human opens the browser.
# ---------------------------------------------------------------------------------------------------
cmd_smoke() {
    local base="http://127.0.0.1:${CONSOLE_PORT}"

    if ! curl -fsS --max-time 2 "${base}/health" >/dev/null 2>&1; then
        warn "nothing is serving on :${CONSOLE_PORT}"
        diagnose_no_answer
        die "nothing to smoke-test"
    fi

    step "Smoke: API surface"
    for route in /health /api/meta /api/projects /api/observe-ports /api/host-profiles /api/plugin-catalog; do
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' "${base}${route}")
        [[ "$code" == "200" ]] || die "GET ${route} → ${code}"
        ok "GET ${route} → 200"
    done

    step "Smoke: SPA bundle is served"
    local html
    html=$(curl -fsS "${base}/" || true)
    if [[ "$html" == *"<div id=\"root\""* || "$html" == *"<script"* ]]; then
        ok "GET / returns the SPA document"
    else
        die "GET / did not return the SPA — the dist bundle is missing from the image (rebuild: ./console.sh)"
    fi
}

# ---------------------------------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------------------------------
cmd_up() {
    local do_build=true
    for a in "$@"; do
        case "$a" in
            --no-build) do_build=false ;;
            -f | --foreground) : ;;
            *) die "invalid flag for up: $a" ;;
        esac
    done

    require_docker

    step "[0/4] Preflight"
    [[ -d "$PRODUCT_STATE_HOST" ]] ||
        die "product state does not exist: ${PRODUCT_STATE_HOST} — run ./harness init profile <consumer> first"
    [[ -f "$PRODUCT_STATE_HOST/workspace.json" ]] ||
        warn "no workspace.json in ${PRODUCT_STATE_HOST} — the Console will start with 0 projects"
    [[ -d "$AGENT_ROOT" ]] ||
        die "agent root does not exist: ${AGENT_ROOT} — export HARNESS_AGENT_ROOT=<directory of repos>"
    ok "product state: ${PRODUCT_STATE_HOST}"
    ok "agent root:    ${AGENT_ROOT}"

    step "[1/4] Port :${CONSOLE_PORT}"
    local holder
    holder=$(port_listener)
    if [[ -n "$holder" ]]; then
        # Expected when this script restarts its own stack; refuse only for a foreign listener.
        if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^harness-console-'; then
            die ":${CONSOLE_PORT} is held by ${holder} — stop it, or run with HARNESS_CONSOLE_PORT=<free port>"
        fi
        ok ":${CONSOLE_PORT} is held by our console stack (${holder}) — replacing it"
    else
        ok ":${CONSOLE_PORT} is free"
    fi

    step "[2/4] Lockfile + SPA bundle"
    if ! bun install --frozen-lockfile >/dev/null 2>&1; then
        die "bun.lock does not match package.json — run: bun install, then ./console.sh"
    fi
    ok "bun.lock matches the workspace"
    if [[ "$do_build" == "true" ]]; then
        if ! (cd "$ROOT" && bun run build:console >/tmp/harness-console-build.log 2>&1); then
            die "build:console failed — see /tmp/harness-console-build.log"
        fi
        ok "SPA bundle: packages/harness-console/dist"
    else
        warn "skipping the SPA build (--no-build) — the image will reuse the bundle baked in last time"
    fi

    step "[3/4] Image + stack ${STACK}"
    if ! console_image_exists; then
        note "no local image yet — building mu/harness-console:local"
        do_build=true
    fi
    if [[ "$do_build" == "true" ]]; then
        node "$CLI" console build || die "docker compose build failed for the console image"
        ok "image mu/harness-console:local"
    fi
    # `up -d` rather than `restart`: compose reconciles mounts/env changes; a plain `start` would keep
    # a container whose bind source no longer exists.
    node "$CLI" console up --no-build || die "docker compose up failed for ${STACK}"

    step "[4/4] Verification"
    # `./console.sh verify` has to work regardless of cwd, and `sh console.sh` does not put the
    # script's directory on PATH on every shell. Re-enter through bash with an absolute path.
    "$SELF" verify
    if [[ "${HARNESS_CONSOLE_OPEN:-0}" == "1" ]]; then
        command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${CONSOLE_PORT}/" || true
    fi
    printf '\nNext: open http://127.0.0.1:%s/ → Projects → add a consumer → ./deploy.sh <id>\n' "$CONSOLE_PORT"
}

cmd_down() {
    require_docker
    node "$CLI" console down
    ok "console stack stopped — :${CONSOLE_PORT} released"
}

cmd_status() {
    require_docker
    local state
    state=$(console_container_state)
    case "$state" in
        running) ok "${STACK}: running" ;;
        exited | created) warn "${STACK}: ${state} — ./console.sh restart" ;;
        *)
            if console_image_exists; then
                warn "not deployed (image mu/harness-console:local exists) — ./console.sh up"
            else
                warn "not deployed, and no image has been built — ./console.sh up"
            fi
            ;;
    esac
    node "$CLI" console status
}

cmd_health() {
    local base="http://127.0.0.1:${CONSOLE_PORT}"
    local health
    if ! health=$(curl -fsS --max-time 2 "${base}/health" 2>/dev/null); then
        warn "nothing is serving on :${CONSOLE_PORT}"
        diagnose_no_answer
        exit 1
    fi
    ok "/health $(json_var "$health" 'return JSON.stringify(j)')"
}

cmd_logs() {
    require_docker
    node "$CLI" console logs "$@"
}

cmd_build() {
    require_docker
    node "$CLI" console build
    ok "image mu/harness-console:local"
}

usage() {
    cat <<EOF
Usage: ./console.sh [command] [flags]

  up        (default) preflight + build if needed + start + verify      --no-build
  verify    check :${CONSOLE_PORT} only, Docker not required             CONSOLE_WAIT_SECONDS=<s>
  smoke     exercise the API surface + SPA bundle
  health    print the raw /health document
  restart   down + up
  down      stop the stack
  status    stack state, plus why it is not serving when it is not
  logs      follow container logs
  build     build the image only, do not start

Env: HARNESS_CONSOLE_PORT (default 8791) · HARNESS_PRODUCT_STATE_HOST (default ~/.harness)
     HARNESS_AGENT_ROOT (default ~/Workspaces) · HARNESS_CONSOLE_OPEN=1 to open the browser
EOF
}

cmd="${1:-up}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
    up | start) cmd_up "$@" ;;
    verify | check) cmd_verify ;;
    smoke) cmd_smoke ;;
    health) cmd_health ;;
    restart) cmd_down && cmd_up "$@" ;;
    down | stop) cmd_down ;;
    status | ps) cmd_status ;;
    logs) cmd_logs "$@" ;;
    build) cmd_build ;;
    -h | --help | help) usage ;;
    *) die "invalid command: ${cmd} (try ./console.sh --help)" ;;
esac
