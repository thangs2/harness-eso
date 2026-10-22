#!/usr/bin/env bash
# Harness ESO — consumer diagnostics (read-only).
#
# Answers one question per layer: "is this consumer set up the way it has to be, and if not, what do
# I do about it?" Every row is a check that either reads a file, asks `harnessctl`, or counts
# something. Nothing is written, nothing is fixed: a diagnostic that repairs what it measures cannot
# be trusted to report a broken consumer.
#
# Usage:
#   ./.harness/diagnostics.sh              # all layers
#   ./.harness/diagnostics.sh L3           # one layer (L0 … L8)
#   ./.harness/diagnostics.sh --json       # machine-readable, for CI
#   ./.harness/diagnostics.sh --verbose    # show every PASS, not just failures
#
# Exit: 0 when every BLOCKER check passes, 1 when one fails, 2 on usage error.
#
# Layer map (matches .harness/ONBOARDING.md):
#   L0 presence · L1 hooks · L2 rules+law · L3 recon · L4 evidence/gate · L5 token diet
#   L6 brain/tools · L7 thin context · L8 observe plane
set -uo pipefail

# `sh diagnostics.sh` is common; re-exec under bash so the reader does not have to know.
if [ -z "${BASH_VERSION:-}" ]; then
    for _b in bash /bin/bash /usr/local/bin/bash /opt/homebrew/bin/bash; do
        if command -v "$_b" >/dev/null 2>&1; then exec "$_b" "$0" "$@"; fi
    done
    echo "diagnostics.sh: bash is required and none was found on PATH" >&2
    exit 2
fi

ROOT="${HARNESS_CONSUMER_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ONLY_LAYER=""
JSON=0
VERBOSE=0
for arg in "$@"; do
    case "$arg" in
        --json) JSON=1 ;;
        --verbose|-v) VERBOSE=1 ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        L[0-8]) ONLY_LAYER="$arg" ;;
        *) echo "diagnostics.sh: unknown argument: $arg" >&2; exit 2 ;;
    esac
done

# ── output primitives ────────────────────────────────────────────────────────────────────────────
# No colour when stdout is not a terminal: a CI log full of escape codes is not a diagnostic.
if [ -t 1 ] && [ "$JSON" = 0 ]; then
    C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'
else
    C_RESET=""; C_DIM=""; C_BOLD=""; C_OK=""; C_WARN=""; C_FAIL=""
fi

ROWS_FILE="$(mktemp "${TMPDIR:-/tmp}/harness-diag.XXXXXX")"
trap 'rm -f "$ROWS_FILE"' EXIT

# record <layer> <severity> <id> <status> <detail> <fix>
# severity: BLOCKER | WARN | INFO. status: PASS | FAIL | SKIP.
_record() {
    local layer="$1" sev="$2" id="$3" status="$4" detail="$5" fix="$6"
    # Fields are tab-separated and newlines are flattened so one row is one line.
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$layer" "$sev" "$id" "$status" \
        "$(printf '%s' "$detail" | tr '\n\t' '  ')" \
        "$(printf '%s' "$fix" | tr '\n\t' '  ')" >>"$ROWS_FILE"
}

layer_active() { [ -z "$ONLY_LAYER" ] || [ "$ONLY_LAYER" = "$1" ]; }
rel() { printf '%s/%s' "${ROOT%/}" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# jq is optional: read a dotted key with node when jq is absent, so the script has no hard dependency
# beyond what the product already requires.
json_get() {
    local file="$1" key="$2"
    if [ ! -f "$file" ]; then return 1; fi
    if have node; then
        node -e '
            const fs = require("node:fs");
            let cur = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            for (const p of process.argv[2].split(".")) {
                if (cur == null || typeof cur !== "object" || !(p in cur)) process.exit(1);
                cur = cur[p];
            }
            process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur));
        ' "$file" "$key" 2>/dev/null && return 0
        return 1
    fi
    return 1
}

# Rule files a host tree would load eagerly. Counted once: both the "this tree has rules" row and the
# token-diet ceiling row measure the same thing, and measuring it twice is how the two drift.
rule_count() {
    local dir="$1"
    [ -d "$dir" ] || { echo 0; return; }
    find "$dir" -maxdepth 1 \( -name '*.mdc' -o -name '*.md' \) 2>/dev/null | wc -l | tr -d ' '
}

count_lines() { [ -f "$1" ] && wc -l <"$1" | tr -d ' ' || echo 0; }

# ── harnessctl bridge ────────────────────────────────────────────────────────────────────────────
# The consumer usually has no harnessctl on PATH. Prefer it when installed, otherwise run the
# checkout's CLI when `HARNESS_ESO_ROOT` points at one (provision exports it into the consumer env).
HARNESSCTL=""
if have harnessctl; then
    HARNESSCTL="harnessctl"
elif [ -n "${HARNESS_ESO_ROOT:-}" ] && [ -f "${HARNESS_ESO_ROOT}/packages/harness-cli/src/cli.mjs" ] && have node; then
    HARNESSCTL="node ${HARNESS_ESO_ROOT}/packages/harness-cli/src/cli.mjs"
fi
run_harnessctl() { [ -n "$HARNESSCTL" ] && $HARNESSCTL "$@" 2>&1; }

# ── L0 · presence ────────────────────────────────────────────────────────────────────────────────
l0() {
    local f
    for f in harness.config.json .harness/decision-policy.json .harness/host-pack/harness-hook.mjs \
             .harness/host-install-state.json .harness/ONBOARDING.md .harness/diagnostics.sh; do
        if [ -e "$(rel "$f")" ]; then
            _record L0 INFO "L0:presence:$f" PASS "present" ""
        else
            local sev=WARN
            case "$f" in harness.config.json|.harness/decision-policy.json|.harness/host-pack/harness-hook.mjs) sev=BLOCKER ;; esac
            _record L0 "$sev" "L0:presence:$f" FAIL "missing" "harnessctl init profile . --host-mode dual-ide"
        fi
    done
}

# ── L1 · hooks wired ─────────────────────────────────────────────────────────────────────────────
l1() {
    local tree cfg
    for tree in cursor agents claude; do
        case "$tree" in
            cursor) cfg=".cursor/hooks.json" ;;
            agents) cfg=".agents/hooks.json" ;;
            claude) cfg=".claude/settings.json" ;;
        esac
        if [ ! -e "$(rel "$cfg")" ]; then
            # A tree that was never provisioned is not a failure; it is absent from the install.
            _record L1 INFO "L1:hook-config:$tree" SKIP "no $tree tree" ""
            continue
        fi
        if grep -q 'harness-hook' "$(rel "$cfg")" 2>/dev/null; then
            _record L1 BLOCKER "L1:hook-config:$tree" PASS "$cfg calls harness-hook" ""
        else
            _record L1 BLOCKER "L1:hook-config:$tree" FAIL "$cfg has no harness-hook reference" \
                "harnessctl host-pack refresh . (merge-safe: keeps your own hooks)"
        fi
    done
    for tree in cursor agents; do
        local guard
        for guard in guard-write.py guard-shell.py; do
            if [ -e "$(rel ".$tree/hooks/$guard")" ]; then
                _record L1 BLOCKER "L1:guard:$tree/$guard" PASS "present" ""
            elif [ -e "$(rel ".$tree/hooks.json")" ]; then
                _record L1 BLOCKER "L1:guard:$tree/$guard" FAIL "missing while $tree is wired" \
                    "harnessctl host-pack refresh ."
            fi
        done
    done
}

# ── L2 · rules + law ─────────────────────────────────────────────────────────────────────────────
l2() {
    if [ -f "$(rel AGENTS.md)" ]; then
        _record L2 BLOCKER "L2:agents-md" PASS "AGENTS.md present ($(count_lines "$(rel AGENTS.md)") lines)" ""
    else
        _record L2 BLOCKER "L2:agents-md" FAIL "AGENTS.md missing" "author AGENTS.md — the law gate reads it first"
    fi

    local tree n
    for tree in cursor agents claude; do
        local dir=".$tree/rules"
        [ -d "$(rel "$dir")" ] || continue
        n=$(rule_count "$(rel "$dir")")
        if [ "$n" -gt 0 ]; then
            _record L2 INFO "L2:rules:$tree" PASS "$n rule file(s) in $dir" ""
        else
            _record L2 WARN "L2:rules:$tree" FAIL "no rules in $dir" "harnessctl fix consumer . (syncs template rules)"
        fi
    done

    if [ -f "$(rel docgraph.scope)" ]; then
        local bad=""
        local p
        while IFS= read -r line; do
            case "$line" in
                path:*) ;;
                *) continue ;;
            esac
            p="${line#path:}"; p="${p%%#*}"; p="$(printf '%s' "$p" | sed 's/[[:space:]]*$//')"
            [ -n "$p" ] || continue
            [ -e "$(rel "$p")" ] || bad="$bad $p"
        done <"$(rel docgraph.scope)"
        if [ -n "$bad" ]; then
            _record L2 WARN "L2:scope-paths" FAIL "docgraph.scope names paths that do not exist:$bad" \
                "create them, or remove the lines — T3.4 fails while they are missing"
        else
            _record L2 WARN "L2:scope-paths" PASS "every path: in docgraph.scope exists" ""
        fi
    else
        _record L2 WARN "L2:scope" FAIL "docgraph.scope missing" "author docgraph.scope, then docgraph build"
    fi

    local law_n
    for law_n in .docgraph documents/document; do
        if [ -d "$(rel "$law_n")" ]; then
            _record L2 INFO "L2:law-index" PASS "$law_n present" ""
            return
        fi
    done
    _record L2 WARN "L2:law-index" FAIL "no .docgraph or documents/document" \
        "docgraph build — law lookups resolve to nothing without an index"
}

# ── L3 · recon trinity ───────────────────────────────────────────────────────────────────────────
l3() {
    local mode recipe=""
    mode=$(json_get "$(rel .harness/decision-policy.json)" eso.mode 2>/dev/null || true)

    [ -d "$(rel .codegraph)" ] && _record L3 INFO "L3:codegraph-index" PASS ".codegraph present" "" \
        || _record L3 WARN "L3:codegraph-index" FAIL ".codegraph missing" "codegraph init -i (or run codegraph_explore once)"

    [ -d "$(rel .docgraph)" ] && _record L3 INFO "L3:docgraph-index" PASS ".docgraph present" "" \
        || _record L3 WARN "L3:docgraph-index" FAIL ".docgraph missing" "docgraph build"

    # A skill that the evidence model relies on but is not installed is invisible otherwise: the gap
    # it was meant to answer stays open with no explanation.
    local skill
    for skill in harness-eso-implement harness-verify; do
        if [ -d "$(rel ".cursor/skills/$skill")" ] || [ -d "$(rel ".agents/skills/$skill")" ] || [ -d "$(rel ".claude/skills/$skill")" ]; then
            _record L3 INFO "L3:skill:$skill" PASS "installed" ""
        else
            _record L3 INFO "L3:skill:$skill" SKIP "not installed (optional)" "copy from harness-eso .cursor/skills/$skill when you want it"
        fi
    done

    if [ -n "$HARNESSCTL" ]; then
        local out
        out=$(run_harnessctl capability probe "$ROOT" --json)
        case "$out" in
            *'"selected": null'*|'')
                _record L3 WARN "L3:capability" FAIL "a provider resolved to none — evidence for that kind cannot be collected" \
                    "harnessctl capability probe . --verbose; check docgraph/codegraph are on PATH"
                ;;
            *)
                _record L3 INFO "L3:capability" PASS "provider chain resolves (mind-set: $mode)" ""
                ;;
        esac
    else
        _record L3 WARN "L3:capability" SKIP "harnessctl unavailable" \
            "export HARNESS_ESO_ROOT=/path/to/harness-eso, or install harnessctl"
    fi
}

# ── L4 · evidence + gate ────────────────────────────────────────────────────────────────────────
l4() {
    local stamp tree found=0
    for tree in cursor agents claude; do
        stamp="$(rel ".$tree/session/.eso-preflight.json")"
        [ -f "$stamp" ] || continue
        found=1
        local level score
        level=$(json_get "$stamp" level 2>/dev/null || echo "?")
        score=$(json_get "$stamp" score 2>/dev/null || echo "?")
        _record L4 INFO "L4:preflight:$tree" PASS "level=$level score=$score" ""

        local closure="$(rel ".$tree/session/.eso-gap-closure.json")"
        if [ -f "$closure" ]; then
            local all
            all=$(json_get "$closure" allClosed 2>/dev/null || echo "false")
            if [ "$all" = "true" ]; then
                _record L4 INFO "L4:gaps:$tree" PASS "all gaps closed" ""
            else
                _record L4 WARN "L4:gaps:$tree" FAIL "gaps still open (write gate will deny gated paths)" \
                    "read the law/code the preflight playbook names, then retry the write"
            fi
        fi
    done
    [ "$found" = 1 ] || _record L4 INFO "L4:preflight" SKIP "no session yet — send one prompt" \
        "the verdict appears after the first turn"

    if [ -n "$HARNESSCTL" ]; then
        if run_harnessctl verify host "$ROOT" >/dev/null 2>&1; then
            _record L4 BLOCKER "L4:verify-host" PASS "H0–H5 pass" ""
        else
            _record L4 BLOCKER "L4:verify-host" FAIL "verify host reports a failing tier" \
                "harnessctl verify host . --json | see which Hn failed"
        fi
    else
        _record L4 WARN "L4:verify-host" SKIP "harnessctl unavailable" "export HARNESS_ESO_ROOT"
    fi
}

# ── L5 · token diet ────────────────────────────────────────────────────────────────────────────
l5() {
    local policy="$(rel .harness/decision-policy.json)"
    local enabled max_rules max_tokens
    enabled=$(json_get "$policy" tokenDiet.enabled 2>/dev/null || echo "")
    max_rules=$(json_get "$policy" tokenDiet.maxEagerRules 2>/dev/null || echo "")
    max_tokens=$(json_get "$policy" tokenDiet.maxEagerTokens 2>/dev/null || echo "")

    if [ "$enabled" = "true" ]; then
        _record L5 WARN "L5:enabled" PASS "tokenDiet.enabled=true" ""
    else
        _record L5 WARN "L5:enabled" FAIL "tokenDiet.enabled is ${enabled:-absent} — every rule loads eagerly" \
            "set tokenDiet.enabled=true (harnessctl fix consumer . → provision seeds it)"
    fi

    # Count what the diet is supposed to bound. A ceiling nobody measures is a claim.
    local eager=0 tree
    for tree in cursor agents claude; do
        eager=$((eager + $(rule_count "$(rel ".$tree/rules")")))
    done
    if [ -n "$max_rules" ] && [ "$max_rules" != "null" ]; then
        if [ "$eager" -le "$max_rules" ]; then
            _record L5 WARN "L5:eager-rules" PASS "$eager rule file(s) ≤ ceiling $max_rules" ""
        else
            _record L5 WARN "L5:eager-rules" FAIL "$eager rule file(s) > ceiling $max_rules" \
                "scope rules per path (glob) instead of loading all of them, or raise maxEagerRules deliberately"
        fi
    fi
    if [ -n "$max_tokens" ] && [ "$max_tokens" != "null" ]; then
        _record L5 INFO "L5:token-ceiling" PASS "maxEagerTokens=$max_tokens" ""
    fi
}

# ── L6 · brain + tools ────────────────────────────────────────────────────────────────────────
l6() {
    local cfg tree found=0
    for tree in cursor agents; do
        for cfg in ".$tree/mcp.json" ".$tree/mcp_config.json"; do
            [ -f "$(rel "$cfg")" ] || continue
            found=1
            if grep -q 'deepseek' "$(rel "$cfg")"; then
                _record L6 INFO "L6:brain-mcp:$tree" PASS "deepseek server configured" ""
            else
                _record L6 WARN "L6:brain-mcp:$tree" FAIL "no deepseek server — guard-brain has no tier to allow" \
                    "add the deepseek MCP server to $cfg (see harness-eso docs/03.cursor-mcp.md)"
            fi
        done
    done
    [ "$found" = 1 ] || _record L6 INFO "L6:brain-mcp" SKIP "no MCP config in this consumer" ""

    # Brain must not open before the gaps it waits on are closed — and must open when they are.
    local blockers="${HOME:-}/.harness/eso-blockers.jsonl"
    if [ -f "$blockers" ]; then
        _record L6 INFO "L6:blockers" PASS "product-state trail at ~/.harness/eso-blockers.jsonl" ""
    else
        _record L6 INFO "L6:blockers" SKIP "no ~/.harness/eso-blockers.jsonl yet" \
            "written only when a gate denies — absence means no denial was recorded, not that none happened"
    fi
}

# ── L7 · thin context ────────────────────────────────────────────────────────────────────────
l7() {
    local guide s
    for guide in .harness/ONBOARDING.md .harness/WORKFLOW_GUIDE.md; do
        if [ -f "$(rel "$guide")" ]; then
            s=$(wc -c <"$(rel "$guide")" | tr -d ' ')
            if [ "$s" -gt 60000 ]; then
                _record L7 INFO "L7:guide-size:$guide" FAIL "$((s / 1024)) KiB — too large to be inlined" \
                    "read it on demand; keep the inlined surface under ~8 KB"
            else
                _record L7 INFO "L7:guide-size:$guide" PASS "$((s / 1024)) KiB" ""
            fi
        else
            _record L7 INFO "L7:guide:$guide" FAIL "missing" "harnessctl fix consumer . (syncs templates)"
        fi
    done
    if [ -f "$(rel .cursor/instructions.md)" ]; then
        s=$(wc -c <"$(rel .cursor/instructions.md)" | tr -d ' ')
        [ "$s" -gt 8000 ] \
            && _record L7 WARN "L7:instructions-size" FAIL ".cursor/instructions.md is $((s / 1024)) KiB (cap ~8 KB)" \
                "move detail into rules/skills; instructions is an index, not a handbook" \
            || _record L7 INFO "L7:instructions-size" PASS "$((s / 1024)) KiB" ""
    fi
}

# ── L8 · observe plane ────────────────────────────────────────────────────────────────────────
l8() {
    local port
    port=$(json_get "$(rel harness.config.json)" server.port 2>/dev/null || echo "")
    if [ -z "$port" ]; then
        _record L8 INFO "L8:port" SKIP "no server.port in harness.config.json" ""
        return
    fi
    if have curl; then
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
            _record L8 INFO "L8:observe" PASS "http://127.0.0.1:$port/health responds" ""
        else
            _record L8 INFO "L8:observe" SKIP "observe not running on :$port" "./harness up (or: harnessctl observatory up)"
        fi
    else
        _record L8 INFO "L8:observe" SKIP "curl unavailable" ""
    fi
}

# ── run ──────────────────────────────────────────────────────────────────────────────────────
if [ ! -d "$ROOT" ]; then
    echo "diagnostics.sh: consumer root not found: $ROOT" >&2
    exit 2
fi

for f in l0 l1 l2 l3 l4 l5 l6 l7 l8; do
    layer=$(printf 'L%s' "${f#l}")
    layer_active "$layer" && "$f"
done

# ── report ───────────────────────────────────────────────────────────────────────────────────
blocker_fail=0
while IFS=$'\t' read -r layer sev id status detail fix; do
    [ "$sev" = "BLOCKER" ] && [ "$status" = "FAIL" ] && blocker_fail=$((blocker_fail + 1))
done <"$ROWS_FILE"

if [ "$JSON" = 1 ]; then
    have node || { echo '{"error":"node is required for --json"}'; exit 2; }
    node -e '
        const fs = require("node:fs");
        const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((l) => {
            const [layer, severity, id, status, detail, fix] = l.split("\t");
            return { layer, severity, id, status, detail, fix };
        });
        const byLayer = {};
        for (const r of rows) (byLayer[r.layer] ??= []).push(r);
        process.stdout.write(JSON.stringify({
            root: process.argv[2],
            ok: !rows.some((r) => r.severity === "BLOCKER" && r.status === "FAIL"),
            summary: {
                pass: rows.filter((r) => r.status === "PASS").length,
                fail: rows.filter((r) => r.status === "FAIL").length,
                skip: rows.filter((r) => r.status === "SKIP").length,
                blockerFail: rows.filter((r) => r.severity === "BLOCKER" && r.status === "FAIL").length,
            },
            layers: byLayer,
        }, null, 2));
    ' "$ROWS_FILE" "$ROOT"
else
    echo ""
    echo "${C_BOLD}Harness ESO — consumer diagnostics${C_RESET}"
    echo "${C_DIM}root:${C_RESET} $ROOT"
    [ -n "$HARNESSCTL" ] && echo "${C_DIM}harnessctl:${C_RESET} $HARNESSCTL" \
        || echo "${C_DIM}harnessctl:${C_RESET} unavailable (export HARNESS_ESO_ROOT to enable capability/verify-host checks)"
    echo ""

    current=""
    while IFS=$'\t' read -r layer sev id status detail fix; do
        if [ "$layer" != "$current" ]; then
            echo "${C_BOLD}${layer}${C_RESET}"
            current="$layer"
            printed=0
        fi
        [ "$VERBOSE" = 1 ] || [ "$status" != "PASS" ] || continue
        printed=$((printed + 1))
        case "$status" in
            PASS) mark="${C_OK}✔${C_RESET}" ;;
            SKIP) mark="${C_DIM}–${C_RESET}" ;;
            *) mark="${C_FAIL}✖${C_RESET}" ;;
        esac
        printf '  %s %-8s %-34s %s\n' "$mark" "$sev" "$id" "$detail"
        [ -n "$fix" ] && printf '      %s%s%s\n' "$C_DIM" "→ $fix" "$C_RESET"
    done <"$ROWS_FILE"

    echo ""
    passes=$(grep -c $'\tPASS\t' "$ROWS_FILE" || true)
    fails=$(grep -c $'\tFAIL\t' "$ROWS_FILE" || true)
    skips=$(grep -c $'\tSKIP\t' "$ROWS_FILE" || true)
    if [ "$blocker_fail" -eq 0 ]; then
        echo "${C_OK}No blocker failed.${C_RESET} ${C_DIM}pass=$passes fail=$fails skip=$skips${C_RESET}"
    else
        echo "${C_FAIL}$blocker_fail blocker(s) failed.${C_RESET} ${C_DIM}pass=$passes fail=$fails skip=$skips${C_RESET}"
        echo "${C_DIM}Next: .harness/ONBOARDING.md lists the layer order and the command for each row.${C_RESET}"
    fi
fi

[ "$blocker_fail" -eq 0 ] && exit 0 || exit 1
