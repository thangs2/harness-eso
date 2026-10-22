#!/usr/bin/env bash
# Provision / re-provision a consumer's ESO profile and host hooks.
#
# Usage:
#   ./provision.sh <consumer | all> [--plan] [--force] [--host-mode dual-ide|all-ide|claude|superset]
#
# Examples:
#   ./provision.sh x79 --plan     # print the file plan, write nothing
#   ./provision.sh x79            # apply
#   ./provision.sh all            # apply to every registered consumer
#
# Exit codes:
#   0  provisioned (or the dry-run plan printed)
#   1  a consumer could not be provisioned
#   2  usage error, or an unknown consumer
#
# This script is one of the four operator entrypoints (deploy.sh, provision.sh,
# verify-consumer.sh, console.sh). It is a thin transport over `harness-cli`: it resolves the
# consumer from the registry, forwards to `init profile`, and then reports the host tier. Keep the
# logic here about *which consumer*, not about *what provisioning does* — the second one lives in
# `packages/harness-foundation/src/init-profile.mjs` and changing it here would be a second definition.
set -euo pipefail

# `sh provision.sh` is a common invocation; re-exec under bash once so the reader does not have to
# know which shell they landed in.
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
    echo "❌ provision.sh: $*" >&2
    exit 1
}

usage() {
    cat <<EOF
Usage: ./provision.sh <consumer | all> [--plan] [--force] [--host-mode dual-ide|all-ide|claude|superset]

  --plan         print the file plan; nothing is written
  --force        rewrite files that are already correct (harness.config.json included)
  --host-mode    which IDE trees to wire (default: the consumer's recorded mode)

Exit: 0 provisioned · 1 a consumer failed · 2 usage error or unknown consumer
EOF
}

# Every project in the registry, one line each: id, port, root, status.
#
# Reads the registry through its own module rather than through `node -e` + string concatenation:
# the port moved from `p.port` to `p.observe.port` in registry v2, and the old expression printed
# `undefined` while the script carried on and provisioned with `--port undefined`.
registry_rows() {
    node --input-type=module -e '
import { loadWorkspace } from "@mu/harness-foundation/workspace";
const ws = loadWorkspace();
for (const p of ws.projects || []) {
    const port = p.observe?.port ?? p.port ?? "";
    const root = p.rootHost || p.root || "";
    const status = p.status || "draft";
    const def = p.id === ws.defaultProjectId ? "*" : " ";
    process.stdout.write([def, p.id, port === "" ? "-" : port, status, root].join("\t") + "\n");
}
' 2>/dev/null || true
}

list_consumers() {
    echo "Registered consumers:"
    local rows
    rows=$(registry_rows)
    if [[ -z "$rows" ]]; then
        echo "  (none — provision a consumer with: ./provision.sh <path-to-consumer>)"
        return
    fi
    while IFS=$'\t' read -r mark id port status root; do
        [[ -z "$id" ]] && continue
        printf '  %s %-16s :%-6s %-12s %s\n' "$mark" "$id" "$port" "$status" "$root"
    done <<< "$rows"
    echo "  (* = default project)   all = every consumer above"
}

# Resolve one consumer id to "id<TAB>port<TAB>root". Fails when the id is unknown or has no port.
resolve_consumer() {
    local wanted="$1"
    local rows
    rows=$(registry_rows)
    local line
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
        echo "   Assign one:  ./console.sh up  →  Projects → open '$wanted', or re-run init profile with --port" >&2
        return 1
    fi
    printf '%s\t%s\t%s\n' "$wanted" "$port" "$root"
}

provision_single_consumer() {
    local proj_id="$1"
    local resolved
    resolved=$(resolve_consumer "$proj_id") || return $?
    local id port root
    IFS=$'\t' read -r id port root <<< "$resolved"

    echo ""
    echo "=================================================="
    printf '⚙️  Provisioning consumer: \033[36m%s\033[0m (port :%s)\n' "$id" "$port"
    echo "   Repo root: $root"
    echo "=================================================="

    local cmd=(node "$CLI" init profile "$root" --id "$id" --name "$id" --port "$port")
    if ((${#extra_flags[@]})); then
        cmd+=("${extra_flags[@]}")
    fi

    local out
    if ! out="$("${cmd[@]}" 2>&1)"; then
        echo "$out" >&2
        echo "❌ provision failed for '$id'" >&2
        return 1
    fi

    # The CLI returns one JSON document. Summarise it, and refuse to pretend when it is not JSON —
    # a stack trace printed as a "plan" is how a failed provision used to look successful.
    if ! printf '%s' "$out" | node --input-type=module -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    // Pretty-printed JSON ends with a lone `}`, so the last line is not the document. Everything
    // from the first `{` is: the CLI may prefix human lines (NO_COLOR banners), never suffix them.
    const start = raw.indexOf("{");
    let res;
    try {
        res = JSON.parse(start < 0 ? raw : raw.slice(start));
    } catch {
        console.log(raw);
        console.error("❌ provision.sh: CLI output was not JSON — see above");
        process.exit(1);
    }
    if (!res.ok) {
        console.error(`❌ ${res.error || "provision reported ok:false"}`);
        process.exit(1);
    }
    if (res.dryRun) {
        console.log("📋 DRY RUN — files that would be written:");
        for (const f of res.files || []) {
            console.log(`   - [${f.action}] ${f.relative} ${f.exists ? "(exists)" : "(new)"}`);
        }
        return;
    }
    console.log("✅ Provisioned");
    console.log(`   host profiles: ${(res.hostProfileIds || []).join(", ") || "(none)"}`);
    console.log(`   observe url:   ${res.observeUrl}`);
    if (res.tokenDiet) {
        console.log(`   token diet:    ${res.tokenDiet.status} (${res.tokenDiet.totalEagerTokens ?? "?"} eager tokens)`);
    }
    const files = res.files || [];
    const count = (s) => files.filter((f) => f.status === s).length;
    console.log(
        `   files:         ${count("created")} created, ${count("merged")} merged, ${count("updated")} updated, ${count("skipped")} skipped`,
    );
});
'; then
        return 1
    fi

    # Conformance is evidence, not decoration: H0–H3 prove the hooks are wired and have fired, H5
    # proves an optimizer cannot edit the gate. Print the tier so a broken provision is visible here.
    echo ""
    echo "🔎 verify host:"
    node "$CLI" verify host "$root" 2>&1 | tail -n 12 || true

    # The guide is copied only when missing, so a newer template never reaches an existing consumer.
    local guide="$root/.harness/WORKFLOW_GUIDE.md"
    local template="$ROOT/profiles/templates/WORKFLOW_GUIDE.md"
    if [[ -f "$guide" && -f "$template" ]] && ! cmp -s "$guide" "$template"; then
        echo ""
        echo "⚠️  WORKFLOW_GUIDE.md is older than the template — sync it with:"
        echo "    ./fix-consumer.sh $id"
    fi
    return 0
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
            [[ $# -eq 0 ]] && die "missing value for --host-mode (exit 2)"
            extra_flags+=("--host-mode" "$1")
            ;;
        -h | --help | help)
            usage
            echo ""
            list_consumers
            exit 0
            ;;
        -*)
            die "invalid flag: $1 (exit 2)"
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

failed=0
if [[ "$target_consumer" == "all" ]]; then
    echo "=================================================="
    echo "🔄 Re-provisioning every registered consumer"
    echo "=================================================="
    while IFS=$'\t' read -r _mark id _port _status _root; do
        [[ -z "$id" ]] && continue
        provision_single_consumer "$id" || failed=$((failed + 1))
    done <<< "$(registry_rows)"
else
    rc=0
    provision_single_consumer "$target_consumer" || rc=$?
    # An unknown consumer (2) is a usage error and must stay distinguishable from a failed provision
    # (1) — a caller script tests the exit code, not the prose.
    if ((rc == 2)); then
        exit 2
    fi
    ((rc == 0)) || failed=$((failed + 1))
fi

echo ""
if ((failed > 0)); then
    echo "❌ provision finished with ${failed} failure(s)" >&2
    exit 1
fi
echo "🎉 Provision complete"
