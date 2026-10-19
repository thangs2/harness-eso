#!/usr/bin/env bash
# Verify / diagnose a consumer against the Consumer Maturity Standard (T0–T5).
# Parallel to provision.sh — read-only; writes only .harness/diagnostics/*
#
# Usage:
#   ./verify-consumer.sh <consumer | all> [--json] [--strict]
#
# Examples:
#   ./verify-consumer.sh fineso
#   ./verify-consumer.sh baplatform --json
#   ./verify-consumer.sh all --strict
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

die() {
    echo "❌ verify-consumer.sh: $*" >&2
    exit 2
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
  console.log(`  - \x1b[33mall\x1b[0m\t(verify tất cả consumer trên)`);
}).catch(() => {});'
}

target_consumer=""
extra_flags=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json|--strict)
            extra_flags+=("$1")
            ;;
        --out)
            shift
            [[ $# -gt 0 ]] || die "missing value for --out"
            extra_flags+=("--out" "$1")
            ;;
        -h|--help|help)
            echo "Cách dùng: ./verify-consumer.sh <consumer | all> [--json] [--strict] [--out <dir>]"
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
    echo "Cách dùng: ./verify-consumer.sh <consumer | all> [--json] [--strict]"
    echo ""
    list_consumers
    exit 2
fi

verify_one() {
    local proj_id="$1"
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
    echo -e "🔎 Verify consumer: \x1b[36m$id\x1b[0m (Port :$port)"
    echo "   Repo root: $root"
    echo "   Standard:  profiles/standards/consumer-maturity.v1.json"
    echo "=================================================="

    local cmd=(node "$CLI" verify consumer "$root" "--project" "$id")
    # path alone is enough; --project unused when path given — keep path only
    cmd=(node "$CLI" verify consumer "$root")
    if ((${#extra_flags[@]})); then
        cmd+=("${extra_flags[@]}")
    fi

    if "${cmd[@]}"; then
        echo "✅ $id — no CRITICAL failures (see .harness/diagnostics/latest.md)"
        return 0
    else
        local ec=$?
        echo "⚠️  $id — diagnostic FAIL (exit $ec) — xem remediations trong .harness/diagnostics/latest.md"
        return "$ec"
    fi
}

overall=0
if [[ "$target_consumer" == "all" ]]; then
    echo "=================================================="
    echo "🔄 Verify TẤT CẢ consumer"
    echo "=================================================="
    all_projects=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  console.log((ws.projects || []).map(p => p.id).join(" "));
});')
    for p in $all_projects; do
        if ! verify_one "$p"; then
            overall=1
        fi
    done
else
    if ! verify_one "$target_consumer"; then
        overall=1
    fi
fi

echo ""
if [[ "$overall" -eq 0 ]]; then
    echo "🎉 Verify xong — không có CRITICAL."
else
    echo "🧯 Verify xong — còn CRITICAL/strict failures. Fix theo remediations rồi chạy lại."
fi
exit "$overall"
