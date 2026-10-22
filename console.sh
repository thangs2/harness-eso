#!/usr/bin/env bash
# Deploy / Re-deploy the Harness Console ():8791 — the surface that manages every consumer profile.
#
# Usage:
#   ./console.sh [up|restart|down|status|health|logs|build|verify|smoke] [--no-build] [--no-browser]
#
# Examples:
#   ./console.sh                     # = up: build (nếu cần) + start + verify
#   ./console.sh verify              # chỉ kiểm định :8791, không đụng Docker
#   ./console.sh restart --no-build  # đổi bind mount / product state mà không rebuild image
#   ./console.sh down                # stop stack harness-console-8791
#
# Design notes (đọc trước khi sửa):
#
#   1. Console là MỘT server cho N profile. Nó không có port riêng cho consumer nào; mỗi profile
#      giữ port Observatory riêng trong `~/.harness/workspace.json`. Vì vậy script này chỉ quan tâm
#      đúng một cổng: :8791. Mọi probe theo từng project đi qua route
#      `/api/projects/<id>/observe-health` — không bao giờ hard-code :8792 ở đây.
#
#   2. "Container running" KHÔNG đồng nghĩa "Console đúng". Ba thứ từng sai mà vẫn healthy:
#      product state mount trỏ sai chỗ (thấy 0 project), agent root mount rỗng (wizard không thấy
#      repo), và observe probe trỏ một port cố định. `verify` kiểm cả ba bằng dữ liệu thật.
#
#   3. Stack identity = `harness-console-<port>` (đặt trong `packages/harness-cli/src/console-cmd.mjs`).
#      Console chỉ một instance trên một host, nên port là identity hợp lý ở đây — khác Observatory,
#      nơi N project chia một image và identity phải là project id.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

CONSOLE_PORT="${HARNESS_CONSOLE_PORT:-8791}"
PRODUCT_STATE_HOST="${HARNESS_PRODUCT_STATE_HOST:-$HOME/.harness}"
AGENT_ROOT="${HARNESS_AGENT_ROOT:-$HOME/Workspaces}"

# Fail loud instead of dying halfway through a build: DSH/agent mounts below are optional, but these
# two are what make the Console usable at all.
export HARNESS_CONSOLE_PORT HARNESS_PRODUCT_STATE_HOST HARNESS_AGENT_ROOT \
    HARNESS_CURSOR_HOME="${HARNESS_CURSOR_HOME:-$HOME/.cursor}" \
    HARNESS_GEMINI_HOME="${HARNESS_GEMINI_HOME:-$HOME/.gemini}"

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok() { printf '   \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
die() {
    printf '\033[31m ✘ console.sh: %s\033[0m\n' "$*" >&2
    exit 1
}

require_docker() {
    command -v docker >/dev/null 2>&1 || die "cần Docker Desktop / Engine"
    docker compose version >/dev/null 2>&1 || die "cần docker compose v2"
    docker info >/dev/null 2>&1 || die "Docker daemon không chạy — mở Docker Desktop / Engine"
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
# verify — the gate. Runs without Docker so it can also be pointed at a dev server (`bun run dev`).
# ---------------------------------------------------------------------------------------------------
cmd_verify() {
    local base="http://127.0.0.1:${CONSOLE_PORT}"
    local waited=0

    step "[1/5] :${CONSOLE_PORT} có trả lời không"
    while ! curl -fsS --max-time 2 "${base}/health" >/dev/null 2>&1; do
        if [[ "$waited" -ge "${CONSOLE_WAIT_SECONDS:-60}" ]]; then
            die "Console không trả lời /health sau ${waited}s — xem: ./console.sh logs"
        fi
        sleep 1
        waited=$((waited + 1))
    done
    local health
    health=$(curl -fsS "${base}/health")
    ok "/health $(json_var "$health" 'return `port=${j.port} service=${j.service}`')"

    step "[2/5] Đây là Console, không phải một Observatory"
    local port_owner
    port_owner=$(json_var "$health" 'return j.service === "harness-console" ? "console" : "other"')
    [[ "$port_owner" == "console" ]] || die ":${CONSOLE_PORT} trả về service khác — đang chạy Observatory trên port Console?"
    ok "service=harness-console"

    step "[3/5] Product state — Console có thấy ĐÚNG registry của host"
    local meta
    meta=$(curl -fsS "${base}/api/meta") || die "không đọc được /api/meta"
    local state_dir projects_dir
    state_dir=$(json_var "$meta" 'return j.productStateDir')
    projects_dir=$(json_var "$meta" 'return j.projectsDir')
    ok "in-container product state: ${state_dir}"
    ok "projects read từ: ${projects_dir}"
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
    local seen_count
    seen_count=$(curl -fsS "${base}/api/observe-ports" | json_field /dev/stdin 'return j.items.length')
    ok "host registry: ${host_count} project · console thấy: ${seen_count}"
    if [[ "$seen_count" != "$host_count" ]]; then
        die "Console thấy ${seen_count}/${host_count} project — mount ${PRODUCT_STATE_HOST} → ${state_dir} sai hoặc volume cũ."
    fi

    step "[4/5] Agent repos — wizard phải thấy thư mục agent trên host"
    local agent_default
    agent_default=$(json_var "$meta" 'return j.agentRootDefault || ""')
    ok "agentRootDefault: ${agent_default:-(trống)}"
    [[ -n "$agent_default" ]] || die "agentRootDefault rỗng — HARNESS_AGENT_ROOT chưa set (hiện: ${AGENT_ROOT})"

    step "[5/5] Mỗi profile probe đúng Observatory của nó"
    local rows
    rows=$(curl -fsS "${base}/api/observe-ports")
    local ids
    ids=$(json_var "$rows" 'return j.items.map((i) => `${i.id}:${i.port}`).join(" ")')
    if [[ -z "$ids" ]]; then
        warn "chưa có project nào — :${CONSOLE_PORT} vẫn là Console hợp lệ, thêm project trong UI"
    else
        for pair in $ids; do
            local id="${pair%%:*}"
            local port="${pair##*:}"
            local resp
            resp=$(curl -sS --max-time 5 "${base}/api/projects/${id}/observe-health" 2>/dev/null || true)
            if [[ -z "$resp" ]]; then
                warn "${id} (port ${port}): không gọi được — Observatory chưa up?"
                continue
            fi
            local reachable
            reachable=$(json_var "$resp" 'return j.ok === true ? "up" : "down"')
            if [[ "$reachable" == "up" ]]; then
                ok "${id} (:${port}) → Observatory up"
            else
                # Expected topology when only the console is being validated: this is a report,
                # not a failure. `./deploy.sh <id>` is the step that makes it green.
                warn "${id} (:${port}) → Observatory chưa up (./deploy.sh ${id})"
            fi
        done
    fi

    printf '\n\033[1;32mConsole OK\033[0m → %s/\n' "$base"
}

# ---------------------------------------------------------------------------------------------------
# smoke — behaviour, not topology. Creates nothing; only reads and exercises the API surface the UI
# depends on, so a broken route is caught before a human opens the browser.
# ---------------------------------------------------------------------------------------------------
cmd_smoke() {
    local base="http://127.0.0.1:${CONSOLE_PORT}"
    step "Smoke: API surface"
    for route in /health /api/meta /api/projects /api/observe-ports /api/host-profiles /api/plugin-catalog; do
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' "${base}${route}")
        [[ "$code" == "200" ]] || die "GET ${route} → ${code}"
        ok "GET ${route} → 200"
    done

    step "Smoke: SPA bundle phục vụ được"
    local html
    html=$(curl -fsS "${base}/" || true)
    if [[ "$html" == *"<div id=\"root\""* || "$html" == *"<script"* ]]; then
        ok "GET / trả về SPA"
    else
        die "GET / không trả SPA (dist chưa build trong image? `./console.sh --no-build` sẽ dùng cache cũ)"
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
            *) die "flag không hợp lệ cho up: $a" ;;
        esac
    done

    require_docker

    step "[0/4] Tiền kiểm môi trường"
    [[ -d "$PRODUCT_STATE_HOST" ]] || die "product state không tồn tại: ${PRODUCT_STATE_HOST} — chạy ./harness init profile trước"
    [[ -f "$PRODUCT_STATE_HOST/workspace.json" ]] || warn "chưa có workspace.json trong ${PRODUCT_STATE_HOST}"
    [[ -d "$AGENT_ROOT" ]] || die "agent root không tồn tại: ${AGENT_ROOT} — export HARNESS_AGENT_ROOT=<thư mục repos>"
    ok "product state: ${PRODUCT_STATE_HOST}"
    ok "agent root:    ${AGENT_ROOT}"

    step "[1/4] Cổng :${CONSOLE_PORT}"
    local holder
    holder=$(lsof -nP -iTCP:"${CONSOLE_PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" pid="$2}' || true)
    if [[ -n "$holder" ]]; then
        # Expected when this script restarts its own stack; refuse only for a foreign listener.
        if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^harness-console-'; then
            die ":${CONSOLE_PORT} đang bị chiếm bởi ${holder} — dừng tiến trình đó rồi chạy lại"
        fi
        ok ":${CONSOLE_PORT} đang do stack console của chúng ta giữ (${holder}) — sẽ thay bằng stack mới"
    else
        ok ":${CONSOLE_PORT} trống"
    fi

    step "[2/4] Lockfile + UI bundle"
    if ! bun install --frozen-lockfile >/dev/null 2>&1; then
        die "bun.lock chưa khớp package.json — chạy: bun install, rồi ./console.sh"
    fi
    ok "bun.lock khớp workspace"
    if [[ "$do_build" == "true" ]]; then
        (cd "$ROOT" && bun run build:console >/tmp/harness-console-build.log 2>&1) ||
            die "build:console thất bại — xem /tmp/harness-console-build.log"
        ok "SPA bundle: packages/harness-console/dist"
    else
        warn "bỏ build SPA (--no-build) — image dùng bundle đã đóng gói lần trước"
    fi

    step "[3/4] Docker image + stack harness-console-${CONSOLE_PORT}"
    if [[ "$do_build" == "true" ]]; then
        node "$CLI" console build || die "docker compose build thất bại"
        ok "image mu/harness-console:local"
    fi
    # `up -d` rather than `restart`: compose reconciles mounts/env changes; a plain `start` would keep
    # a container whose bind source no longer exists.
    node "$CLI" console up --no-build || die "docker compose up thất bại"

    step "[4/4] Kiểm định"
    cmd_verify
    if [[ "${HARNESS_CONSOLE_OPEN:-0}" == "1" ]]; then
        command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${CONSOLE_PORT}/" || true
    fi
    printf '\nTiếp theo: mở http://127.0.0.1:%s/ → Projects → thêm consumer → ./deploy.sh <id>\n' "$CONSOLE_PORT"
}

cmd_down() {
    require_docker
    node "$CLI" console down
    ok "stack console đã dừng — :${CONSOLE_PORT} đã giải phóng"
}

cmd_status() {
    require_docker
    node "$CLI" console status
}

cmd_logs() {
    require_docker
    node "$CLI" console logs "$@"
}

cmd_build() {
    require_docker
    node "$CLI" console build
}

usage() {
    cat <<EOF
Cách dùng: ./console.sh [command] [flags]

  up        (mặc định) build nếu cần + start + verify        --no-build
  verify    chỉ kiểm định :${CONSOLE_PORT} (không cần Docker)  CONSOLE_WAIT_SECONDS=<s>
  smoke     kiểm tra API surface + SPA
  restart   down + up
  down      dừng stack
  status    docker compose ps
  logs      follow logs
  build     chỉ build image

Env: HARNESS_CONSOLE_PORT (mặc định 8791) · HARNESS_PRODUCT_STATE_HOST (mặc định ~/.harness)
     HARNESS_AGENT_ROOT (mặc định ~/Workspaces) · HARNESS_CONSOLE_OPEN=1 để tự mở browser
EOF
}

cmd="${1:-up}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
    up | start) cmd_up "$@" ;;
    verify | check) cmd_verify ;;
    smoke) cmd_smoke ;;
    restart) cmd_down && cmd_up "$@" ;;
    down | stop) cmd_down ;;
    status | ps) cmd_status ;;
    logs) cmd_logs "$@" ;;
    build) cmd_build ;;
    -h | --help | help) usage ;;
    *) die "command không hợp lệ: ${cmd} (thử ./console.sh --help)" ;;
esac
