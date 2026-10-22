#!/usr/bin/env bash
# Verify a consumer against the Consumer Maturity Standard (T0–T5).
#
# Read-only with respect to the consumer's source: the only thing it writes is
# `<consumer>/.harness/diagnostics/*`. Parallel to provision.sh.
#
# Usage:
#   ./verify-consumer.sh <consumer | all> [--json] [--strict] [--out <dir>]
#
# Examples:
#   ./verify-consumer.sh x79
#   ./verify-consumer.sh x79 --json          # machine-readable report on stdout
#   ./verify-consumer.sh all --strict        # every consumer, warnings count as failures
#
# Exit codes:
#   0  nothing CRITICAL (and nothing failing at all, with --strict)
#   1  at least one CRITICAL or (--strict) non-passing check
#   2  usage error, or an unknown consumer
#
# One of the four operator entrypoints (deploy.sh, provision.sh, verify-consumer.sh, console.sh).
# It resolves the consumer from the registry and forwards to `harness-cli verify consumer`. The
# checks themselves are not here: a rule that lived in this script would drift from the standard the
# Console renders, and the two would disagree about the same consumer.
set -euo pipefail

# Re-exec under bash once: `sh verify-consumer.sh x79` is a documented invocation.
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
    echo "❌ verify-consumer.sh: $*" >&2
    exit 2
}

usage() {
    cat <<EOF
Usage: ./verify-consumer.sh <consumer | all> [--json] [--strict] [--out <dir>]

  --json     write the report as JSON to stdout (no summary prose)
  --strict   treat every non-passing check as a failure, not just CRITICAL
  --out      write the report to this directory instead of <consumer>/.harness/diagnostics

Exit: 0 clean · 1 CRITICAL or strict failure · 2 usage error or unknown consumer
EOF
}

# Every project in the registry, one line each: mark, id, port, status, root.
#
# Read through the registry module rather than a hand-built `node -e` expression: the port moved from
# `p.port` to `p.observe.port` in registry v2, and `p.port || 8792` then printed 8792 for every
# consumer — a verification report that names the wrong port is worse than one that says "none".
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
        echo "  (none — provision a consumer first: ./provision.sh <consumer>)"
        return
    fi
    while IFS=$'\t' read -r mark id port status root; do
        [[ -z "$id" ]] && continue
        printf '  %s %-16s :%-6s %-12s %s\n' "$mark" "$id" "$port" "$status" "$root"
    done <<< "$rows"
    echo "  (* = default project)   all = every consumer above"
}

# Resolve one consumer id to "id<TAB>root". Verification needs the root, not the port: a consumer
# that is not deployed yet still has files worth checking. Exit 2 when unknown.
resolve_consumer() {
    local wanted="$1"
    local rows line root
    rows=$(registry_rows)
    line=$(printf '%s\n' "$rows" | awk -F'\t' -v id="$wanted" '$2 == id { print; exit }')
    if [[ -z "$line" ]]; then
        echo "❌ Unknown consumer: '$wanted' — it is not in the registry." >&2
        list_consumers >&2
        return 2
    fi
    root=$(printf '%s' "$line" | cut -f5)
    if [[ -z "$root" ]]; then
        echo "❌ Consumer '$wanted' has no root recorded in the registry." >&2
        return 1
    fi
    printf '%s\t%s\n' "$wanted" "$root"
}

verify_one() {
    local proj_id="$1"
    local resolved
    resolved=$(resolve_consumer "$proj_id") || return $?
    local id root
    IFS=$'\t' read -r id root <<< "$resolved"

    echo ""
    # --json promises a machine-readable document on stdout. The banner is prose, so it goes to
    # stderr in that mode: a consumer of this command pipes stdout into a parser, and a banner in
    # front of the JSON is the difference between a working CI step and a broken one.
    if [[ "$is_json" == "true" ]]; then
        {
            echo "🔎 Verify consumer: $id"
            echo "   Repo root: $root"
            echo "   Standard:  profiles/standards/consumer-maturity.v1.json"
        } >&2
    else
        echo "=================================================="
        echo "🔎 Verify consumer: $id"
        echo "   Repo root: $root"
        echo "   Standard:  profiles/standards/consumer-maturity.v1.json"
        echo "=================================================="
    fi

    # The CLI resolves the standard and writes the diagnostics report; this script only decides which
    # consumer and how to report the exit code.
    local args=(verify consumer "$root")
    if ((${#extra_flags[@]})); then
        args+=("${extra_flags[@]}")
    fi

    local ec=0
    node "$CLI" "${args[@]}" || ec=$?
    if ((ec == 0)); then
        # In --json mode stdout already holds the document; the prose goes to stderr so the caller can
        # still pipe stdout into a parser.
        if [[ "$is_json" == "true" ]]; then
            echo "✅ $id — no CRITICAL failures (report: .harness/diagnostics/latest.md)" >&2
        else
            echo "✅ $id — no CRITICAL failures (report: .harness/diagnostics/latest.md)"
        fi
        return 0
    fi
    echo "⚠️  $id — verification failed (exit $ec) — see the remediations in .harness/diagnostics/latest.md" >&2
    return 1
}

target_consumer=""
extra_flags=()
is_json=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json | --strict)
            [[ "$1" == "--json" ]] && is_json=true
            extra_flags+=("$1")
            ;;
        --out)
            shift
            [[ $# -gt 0 ]] || die "missing value for --out (exit 2)"
            extra_flags+=("--out" "$1")
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

if [[ "$target_consumer" != "all" ]]; then
    rc=0
    resolve_consumer "$target_consumer" >/dev/null || rc=$?
    ((rc == 0)) || exit "$rc"
fi

overall=0
if [[ "$target_consumer" == "all" ]]; then
    echo "=================================================="
    echo "🔄 Verifying every registered consumer"
    echo "=================================================="
    while IFS=$'\t' read -r _mark id _port _status _root; do
        [[ -z "$id" ]] && continue
        verify_one "$id" || overall=1
    done <<< "$(registry_rows)"
else
    verify_one "$target_consumer" || overall=1
fi

echo ""
if [[ "$overall" -eq 0 ]]; then
    if [[ "$is_json" == "true" ]]; then
        echo "🎉 Verification complete — nothing CRITICAL." >&2
    else
        echo "🎉 Verification complete — nothing CRITICAL."
    fi
else
    echo "🧯 Verification complete — CRITICAL or strict failures remain. Fix the remediations and re-run." >&2
fi
exit "$overall"
