#!/usr/bin/env bash
# Semi-auto fix for a consumer from maturity diagnostic remediations.
# Parallel to provision.sh / verify-consumer.sh.
#
# AUTO-SAFE: sync WORKFLOW_GUIDE, mkdir session dirs, host-pack refresh, optional provision
# NEVER auto: context-contract / agent-manifests / domain rules → OPEN_FIXES.md
#
# Usage:
#   ./fix-consumer.sh <consumer | all> [--dry-run] [--from-latest] [--force-provision] [--no-provision] [--strict] [--json]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLI="$ROOT/packages/harness-cli/src/cli.mjs"

die() {
    echo "❌ fix-consumer.sh: $*" >&2
    exit 2
}

list_consumers() {
    echo "Danh sách consumer khả dụng:"
    node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  const ws = loadWorkspace();
  for (const p of ws.projects || []) {
    console.log(`  - \x1b[36m${p.id}\x1b[0m\t→ ${p.rootHost || p.root}`);
  }
  console.log(`  - \x1b[33mall\x1b[0m`);
}).catch(() => {});'
}

target_consumer=""
extra_flags=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run|--from-latest|--force-provision|--no-provision|--strict|--json|--no-reverify)
            extra_flags+=("$1")
            ;;
        -h|--help|help)
            echo "Cách dùng: ./fix-consumer.sh <consumer | all> [--dry-run] [--from-latest] [--force-provision] [--no-provision] [--strict] [--json]"
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
                die "chỉ 1 consumer"
            fi
            ;;
    esac
    shift
done

[[ -n "$target_consumer" ]] || {
    echo "⚠️  Chưa truyền consumer"
    list_consumers
    exit 2
}

fix_one() {
    local proj_id="$1"
    local info
    info=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace, resolveProject }) => {
  const ws = loadWorkspace();
  const p = resolveProject(ws, process.argv[1]);
  console.log(`${p.id} ${p.rootHost || p.root}`);
}).catch(() => { console.error("NOT_FOUND"); process.exit(1); });' "$proj_id" 2>/dev/null) || true

    if [[ -z "$info" || "$info" == *"NOT_FOUND"* ]]; then
        echo "❌ Không tìm thấy consumer '$proj_id'"
        return 1
    fi
    local id root
    read -r id root <<< "$info"

    echo ""
    echo "=================================================="
    echo -e "🛠️  Fix consumer: \x1b[36m$id\x1b[0m"
    echo "   Repo: $root"
    echo "=================================================="

    local cmd=(node "$CLI" fix consumer "$root")
    if ((${#extra_flags[@]})); then
        cmd+=("${extra_flags[@]}")
    fi
    "${cmd[@]}"
}

overall=0
if [[ "$target_consumer" == "all" ]]; then
    all_projects=$(node -e '
import("@mu/harness-foundation/workspace").then(({ loadWorkspace }) => {
  console.log((loadWorkspace().projects || []).map(p => p.id).join(" "));
});')
    for p in $all_projects; do
        if ! fix_one "$p"; then overall=1; fi
    done
else
    if ! fix_one "$target_consumer"; then overall=1; fi
fi

echo ""
echo "Xong. Xem OPEN_FIXES.md trong consumer/.harness/diagnostics/ cho phần domain còn lại."
exit "$overall"
