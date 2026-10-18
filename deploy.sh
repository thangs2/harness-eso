#!/usr/bin/env bash
# Deploy / Re-deploy Observatory Docker container for a given consumer.
#
# Usage:
#   ./deploy.sh <consumer | all> [--no-build] [--smoke]
#
# Examples:
#   ./deploy.sh x79
#   ./deploy.sh baplatform
#   ./deploy.sh fineso
#   ./deploy.sh all
#   sh deploy.sh x79 --no-build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

die() {
    echo "❌ deploy.sh: $*" >&2
    exit 1
}

# 1. Kiểm tra Docker
require_docker() {
    command -v docker >/dev/null 2>&1 || die "cần Docker Desktop / Engine"
    docker compose version >/dev/null 2>&1 || die "cần docker compose v2"
    docker info >/dev/null 2>&1 || die "Docker daemon không chạy — hãy mở Docker Desktop / Engine"
}

# 2. Lấy danh sách project từ workspace
get_projects_json() {
    node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  console.log(JSON.stringify(ws.projects || []));
}).catch(err => {
  console.error(err);
  process.exit(1);
});'
}

list_consumers() {
    echo "Danh sách consumer khả dụng:"
    node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  for (const p of ws.projects || []) {
    const isDef = p.id === ws.defaultProjectId ? " (mặc định)" : "";
    console.log(`  - \x1b[36m${p.id}\x1b[0m\t(port :${p.port || 8792})${isDef} \t→ ${p.rootHost || p.root}`);
  }
  console.log(`  - \x1b[33mall\x1b[0m\t(re-deploy tất cả các consumer trên)`);
}).catch(() => {});'
}

# 3. Build UI bundle & Docker image
do_build=true
do_smoke=false
target_consumer=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-build)
            do_build=false
            ;;
        --smoke)
            do_smoke=true
            ;;
        -h|--help|help)
            echo "Cách dùng: ./deploy.sh <consumer | all> [--no-build] [--smoke]"
            echo ""
            list_consumers
            exit 0
            ;;
        -*)
            die "flag không hợp lệ: $1"
            ;;
        *)
            if [[ -z "$target_consumer" ]]; then
                target_consumer="$1"
            else
                die "chỉ chấp nhận 1 tên consumer (nhận được: $target_consumer, $1)"
            fi
            ;;
    esac
    shift
done

if [[ -z "$target_consumer" ]]; then
    echo "⚠️  Chưa truyền tên consumer!"
    echo "Cách dùng: ./deploy.sh <consumer | all> [--no-build] [--smoke]"
    echo ""
    list_consumers
    exit 2
fi

require_docker

build_images() {
    if [[ "$do_build" == "true" ]]; then
        echo "=================================================="
        echo "🔨 [1/3] Build frontend bundle (Observatory SPA)"
        echo "=================================================="
        (cd "$ROOT" && bun run build:observatory)
        
        echo ""
        echo "=================================================="
        echo "🐳 [2/3] Build Docker image (mu/harness-observe:local)"
        echo "=================================================="
        node "$CLI" observatory build
    else
        echo "⏩ Bỏ qua bước build image (--no-build)"
    fi
}

deploy_single_consumer() {
    local proj_id="$1"
    
    # Lấy thông tin port và root từ workspace
    local info
    info=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace, resolveProject }) => {
  const ws = loadWorkspace();
  const p = resolveProject(ws, process.argv[1]);
  console.log(`${p.id} ${p.port || 8792} ${p.rootHost || p.root}`);
}).catch(err => {
  console.error("NOT_FOUND");
  process.exit(1);
});' "$proj_id" 2>/dev/null) || true

    if [[ -z "$info" || "$info" == *"NOT_FOUND"* ]]; then
        echo "❌ Không tìm thấy consumer '$proj_id' trong workspace!"
        list_consumers
        return 1
    fi

    local id port root
    read -r id port root <<< "$info"

    echo ""
    echo "=================================================="
    echo "🚀 Triển khai cho consumer: $id (Port :$port)"
    echo "   Repo root: $root"
    echo "=================================================="

    node "$CLI" observatory restart --project "$id"

    echo ""
    echo "⏳ Đang kiểm tra sức khỏe container trên port $port..."
    local ok=false
    for _ in {1..15}; do
        if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
            ok=true
            break
        fi
        sleep 1
    done

    if [[ "$ok" == "true" ]]; then
        echo "✅ Consumer '$id' đã sẵn sàng tại: http://127.0.0.1:${port}/"
        if [[ "$do_smoke" == "true" ]]; then
            echo ""
            echo "🧪 Chạy smoke check trên port $port..."
            HARNESS_OBSERVE_PORT="$port" node "$CLI" observatory smoke
        fi
    else
        echo "⚠️ Container đã bật nhưng healthcheck chưa phản hồi trên port $port. Xem log:"
        HARNESS_OBSERVE_PORT="$port" node "$CLI" observatory logs || true
    fi
}

# Bắt đầu thực thi
build_images

if [[ "$target_consumer" == "all" ]]; then
    echo ""
    echo "=================================================="
    echo "🔄 Re-deploy TẤT CẢ các consumer"
    echo "=================================================="
    all_projects=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  console.log((ws.projects || []).map(p => p.id).join(" "));
});')
    for p in $all_projects; do
        deploy_single_consumer "$p"
    done
else
    deploy_single_consumer "$target_consumer"
fi

echo ""
echo "🎉 Hoàn tất deploy!"
