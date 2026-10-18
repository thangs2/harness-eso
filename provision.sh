#!/usr/bin/env bash
# Provision / Re-provision ESO profile and host hooks for a given consumer.
#
# Usage:
#   ./provision.sh <consumer | all> [--plan] [--force] [--host-mode dual-ide|all-ide|claude|superset]
#
# Examples:
#   ./provision.sh x79
#   ./provision.sh baplatform
#   ./provision.sh fineso
#   ./provision.sh all
#   ./provision.sh x79 --plan
#   ./provision.sh all --force
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

die() {
    echo "❌ provision.sh: $*" >&2
    exit 1
}

# Lấy danh sách consumer từ workspace
list_consumers() {
    echo "Danh sách consumer khả dụng:"
    node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  for (const p of ws.projects || []) {
    const isDef = p.id === ws.defaultProjectId ? " (mặc định)" : "";
    console.log(`  - \x1b[36m${p.id}\x1b[0m\t(port :${p.port || 8792})${isDef} \t→ ${p.rootHost || p.root}`);
  }
  console.log(`  - \x1b[33mall\x1b[0m\t(re-provision tất cả các consumer trên)`);
}).catch(() => {});'
}

target_consumer=""
extra_flags=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan)
            extra_flags+=("--plan")
            ;;
        --force)
            extra_flags+=("--force")
            ;;
        --host-mode)
            shift
            if [[ $# -eq 0 ]]; then die "missing value for --host-mode"; fi
            extra_flags+=("--host-mode" "$1")
            ;;
        -h|--help|help)
            echo "Cách dùng: ./provision.sh <consumer | all> [--plan] [--force] [--host-mode dual-ide|all-ide|claude|superset]"
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
    echo "Cách dùng: ./provision.sh <consumer | all> [--plan] [--force] [--host-mode dual-ide|all-ide|claude|superset]"
    echo ""
    list_consumers
    exit 2
fi

provision_single_consumer() {
    local proj_id="$1"

    # Lấy thông tin port và root từ workspace
    local info
    info=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace, resolveProject }) => {
  const ws = loadWorkspace();
  const p = resolveProject(ws, process.argv[1]);
  console.log(`${p.id} ${p.port || 8792} ${p.rootHost || p.root}`);
}).catch(() => {
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
    echo -e "⚙️  Provision cho consumer: \x1b[36m$id\x1b[0m (Port :$port)"
    echo "   Repo root: $root"
    echo "=================================================="

    local cmd=(node "$CLI" init profile "$root" --id "$id" --name "$id" --port "$port")
    if ((${#extra_flags[@]})); then
        cmd+=("${extra_flags[@]}")
    fi

    local out
    out="$("${cmd[@]}")"

    # Hiển thị tóm tắt kết quả
    node -e '
const res = JSON.parse(process.argv[1]);
if (!res.ok) {
  console.error("❌ Thất bại:", res);
  process.exit(1);
}
if (res.dryRun) {
  console.log("📋 [DRY-RUN PLAN] Các file dự kiến ghi:");
  for (const f of res.files || []) {
    const exists = f.exists ? "(đã tồn tại)" : "(mới)";
    console.log(`   - [${f.action}] ${f.relative} ${exists}`);
  }
} else {
  console.log("✅ Provision thành công!");
  console.log(`   Host Profile: ${(res.hostProfileIds || []).join(", ")}`);
  console.log(`   Observe URL:  ${res.observeUrl}`);
  if (res.tokenDiet) {
    const tokens = res.tokenDiet.totalEagerTokens ?? "N/A";
    console.log(`   Token Diet:   status=${res.tokenDiet.status} (${tokens} eager tokens)`);
  }
  const files = res.files || [];
  const created = files.filter(f => f.status === "created").length;
  const merged = files.filter(f => f.status === "merged").length;
  const updated = files.filter(f => f.status === "updated").length;
  const skipped = files.filter(f => f.status === "skipped").length;
  console.log(`   Files:        ${created} created, ${merged} merged, ${updated} updated, ${skipped} skipped`);
}
' "$out"
}

if [[ "$target_consumer" == "all" ]]; then
    echo "=================================================="
    echo "🔄 Re-provision TẤT CẢ các consumer"
    echo "=================================================="
    all_projects=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  console.log((ws.projects || []).map(p => p.id).join(" "));
});')
    for p in $all_projects; do
        provision_single_consumer "$p"
    done
else
    provision_single_consumer "$target_consumer"
fi

echo ""
echo "🎉 Hoàn tất provision!"
