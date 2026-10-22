# Addendum — 2026-10-22 · `fineso` follow-up probes (OPEN items 4 + 5 from the session log)

> **Status:** verified evidence, read-only on the consumer. Continues
> [`./agent-session-log-2026-10-22-fineso-envcheck.md`](./agent-session-log-2026-10-22-fineso-envcheck.md)
> (§7 OPEN-4 "token-diet via the official linter", §7 OPEN-1 "stop hook" partially, §5 "route
> event vocabulary"). Same rules: this is a review artifact, not documentation, not law.
>
> **Consumer left untouched.** `git status -s` in `FinESO/` was identical before and after
> (7 untracked `.agents/rules/*.mdc` + `M .cursor/mcp.json`, all pre-existing).

---

## 1. `token-diet` — the official linter **FAILS** where my `rg` count said PASS

The session log measured eager rules with `rg -l "alwaysApply:\s*true"` and reported "6/7, within
budget". The official linter reads frontmatter and finds a **second** assertion, which my count could
not see.

```bash
node ~/Workspaces/harness-eso/packages/harness-cli/src/cli.mjs token-diet /Users/thangs2net/Workspaces/FinESO
```

```
Tree: .cursor  [FAIL]
  PASS  Eager rules count: 6 / max 7
  PASS  Eager tokens estimate: ~3,795 / max 10,000 tokens (15,382 bytes)
  FAIL  No alwaysApply + globs conflict (1 conflict(s))
  PASS  Lazy rules declare globs (0 missing)
  Eager Rules (6): core.conversation-hygiene / core.law-gate / core.pipeline-gate /
                   core.scope-fallback / core.workspace-isolation / fineso.engineering-slp
  Harness Root Files (2): AGENTS.md, .cursor/instructions.md
  Lazy Rules (19)
  FAIL Conflicts: .cursor/rules/fineso.engineering-slp.mdc:
                  Rule declares both alwaysApply: true and globs

Tree: .agents  [FAIL]
  PASS  Eager rules count: 6 / max 7
  PASS  Eager tokens estimate: ~3,602 / max 10,000 tokens (14,646 bytes)
  FAIL  No alwaysApply + globs conflict (1 conflict(s))
  PASS  Lazy rules declare globs (0 missing)
  ... identical conflict on .agents/rules/fineso.engineering-slp.md
```

JSON (`--json`) summary:

```json
{ "status": "fail", "tree": "all",
  "trees": {
    "cursor": { "status": "fail", "assertions": {
        "ruleCount":  { "pass": true, "actual": 6,    "budget": 7 },
        "tokenBudget":{ "pass": true, "actual": 3795, "budget": 10000 },
        "frontmatterIntegrity": { "pass": false, "conflicts": [
            { "file": ".cursor/rules/fineso.engineering-slp.mdc",
              "reason": "Rule declares both alwaysApply: true and globs" } ] },
        "lazyGlobs":  { "pass": true, "missing": [] } },
      "summary": { "eagerRulesCount": 6, "lazyRulesCount": 19, "totalRulesCount": 25,
                   "totalEagerTokens": 3795, "totalEagerBytes": 15382 } } } }
```

The conflicting frontmatter, verbatim (`.cursor/rules/fineso.engineering-slp.mdc:1-5` **and**
`.agents/rules/fineso.engineering-slp.md:1-5` — byte-identical, so this is not a dual-harness
divergence, it is one rule that is both eager and scoped):

```yaml
---
description: Thất Tinh Trận (ENG_PLANE) — 7 engineering roles. Never conflate with Lục Mạch Thần Kiếm (product).
globs: packages/**/*.{ts,mjs,js,json},SDLC/**/*.{md,json},.cursor/agents/**,.agents/agents/**
alwaysApply: true
---
```

**Verdict: consumer-side drift, and a direct conflict with the harness's own prescribed design.**
`.harness/WORKFLOW_GUIDE.md` §3 says "Mọi rule chuyên môn (backend, frontend, database, Jira, WBS)
phải đặt `alwaysApply: false` kèm trường `globs:`". `fineso.engineering-slp` is a plane rule — arguably
eager by intent — but it declares both, which makes the linter's assertion meaningless for that file.
The owner must choose: drop `globs:` (keep eager) or drop `alwaysApply: true` (make it scoped).
Consequence of leaving it: **`token-diet` FAIL is invisible to `verify-consumer.sh`**, so the
consumer's "T5 / 25 pass / 0 fail" is green while a documented performance assertion is red.

### 1.1 Why F-6 from the session log is unaffected

`token-diet` counts 19 lazy rules and 0 missing globs on both trees — the lazy population is
healthy. The only failure is the single intentional-looking contradiction above.

---

## 2. `route` event vocabulary and the `stop` row — OPEN-1 **resolved**

Session-log §5 noted "no `stop` row for this generation" and left OPEN-1 open. The generation has
since closed (`stop` at `13:38:54Z`), and the row **did land**, so the cursor `stop` → `route` path
works. The structural reason it can be missing mid-session:

`harness-hook.mjs:3089-3113` (`run7` = `route`) spawns
`python3 route-hook.py --harness <id> [--event <event>]` and **fails open** (`failOpenStdout`) when
the script is missing or prints nothing.

`route-hook.py:258-265` — the only event names the adapter accepts:

```python
AGY_EVENTS = ("PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop")
AGY_EVENT_MAP = { "PreToolUse": "preToolUse", "PostToolUse": "postToolUse",
                  "PreInvocation": "preInvocation", "PostInvocation": "postInvocation",
                  "Stop": "stop" }
```

The cursor `stop` hook in `.cursor/hooks.json` passes **no** `--event`:
`exec node .harness/host-pack/harness-hook.mjs --hook route --tree cursor`. So `parse_event(argv)`
returns `""` and the adapter falls back to `hook_event_name` inside the payload
(`route-hook.py:299-310`). The closed generation proves Cursor's `stop` payload does carry it
(`payload.hook_event_name: "stop"`), and the row was written.

**Verdict: no defect here.** The lesson is about the *shape* of the evidence: `stop` rows are the only
per-generation completeness signal, they arrive **only at generation end**, and a missing one is
**silent** — `route` fails open with no counter, no warning and nothing on `/health` (which reports
`spineOk` for ingest only). An agent reading the trace mid-turn must not conclude "stop is broken".

### 2.1 Final `stop` payload for this generation (verbatim, `user_email` redacted)

```json
{ "status": "completed", "loop_count": 0,
  "input_tokens": 3998836, "output_tokens": 24068,
  "cache_read_tokens": 3898880, "cache_write_tokens": 0,
  "model": "unknown", "model_id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "hook_event_name": "stop" }
```

`cache_read / input = 97.5 %`, `loop_count: 0` — no agent loop retries. Token *growth* is the
conversation, not a loop.

### 2.2 Rate snapshot (why this matters for the harness, not for the agent)

| | rows | ≈ rows/day |
|---|---:|---:|
| `route-trace.jsonl` total | 2,024 | — |
| generation `8b8a…` (20 Oct) | 92 | |
| generation `26c1…` (22 Oct, this one) | 98 | |
| **today, 22 Oct** | **1,790** | **~1,790** |

Two days' trace ≈ 2,024 rows; **88 % of it is 22 Oct**. The observe plane reports
`lastIngest.ms: 614` → `ms: 6,283` (10×) across one session while `counts.requests` stayed at 254 —
ingest cost is scaling with **file size**, and `scope: "0 requests / 0 gens"` still took 614 ms on an
idle poll. At ~1.8k rows/day a `route-trace.jsonl` rewrite every 2 s (`ingest.pollMs: 2000`) is worth
measuring before it becomes the next `x79`-class finding. **Not measured further this session** —
recorded so the next session starts from a number instead of a hunch (OPEN-7).

---

## 3. Correction to the session log (agent self-audit A-8)

| # | Defect | Cost | Proposed guard |
|---|---|---|---|
| **A-8** | Reported "eager rules 6/7 (đúng budget)" from a `rg` count and never ran the official linter, even though `WORKFLOW_GUIDE.md` §4.A and OPEN-4 both name `./harness token-diet`. The conclusion was **wrong** the moment `frontmatterIntegrity` is considered | One FAIL assertion missed in the first report; corrected in §1 | When a guide names the canonical checker, run the canonical checker — a hand-rolled proxy (`rg -l`) answers a different question and reads as an endorsement |

Also corrected: the session log's wording "eager rules 6/7 (đúng budget)" is true for
`ruleCount` and `tokenBudget`, and false for `status` — the same reading error as F-2 ("`hint` looks
like no enforcement") but on the reporting side.

---

## 4. Reproduce

```bash
# 1. token-diet, both trees + JSON
node ~/Workspaces/harness-eso/packages/harness-cli/src/cli.mjs token-diet /Users/thangs2net/Workspaces/FinESO --json

# 2. the conflicting rule, both trees
sed -n '1,5p' /Users/thangs2net/Workspaces/FinESO/.cursor/rules/fineso.engineering-slp.mdc
sed -n '1,5p' /Users/thangs2net/Workspaces/FinESO/.agents/rules/fineso.engineering-slp.md

# 3. route event vocabulary (read, do not probe)
sed -n '258,266p' /Users/thangs2net/Workspaces/FinESO/.harness/host-pack/route-hook.py
sed -n '3089,3113p' /Users/thangs2net/Workspaces/FinESO/.harness/host-pack/harness-hook.mjs
grep -n 'route --tree cursor' /Users/thangs2net/Workspaces/FinESO/.cursor/hooks.json
```

## 5. Updated OPEN

1. **OPEN-1 — CLOSED.** `stop` row landed at `13:38:54Z` with `status: "completed"`; Cursor does send
   `hook_event_name` on `stop`, and `route` with no `--event` resolves it from the payload. Only the
   *mid-turn absence* was ever observed.
2. **OPEN-4 — resolved as FAIL** (not PASS) — see §1. Owner decision required on
   `fineso.engineering-slp`; not taken here (gated path).
3. OPEN-2, OPEN-3, OPEN-6 from the session log unchanged.
4. **OPEN-7 (new):** ingest cost vs `route-trace.jsonl` growth — ~1,790 rows on 22 Oct, and an idle
   poll already costs 614 ms for `0 requests / 0 gens`. Measure `POST /ingest` wall time against file
   size; if it is linear, the 2 s `pollMs` budget is already spent before any work is done.

## 6. Artifact refresh

`agent-session-2026-10-22T1324Z/turn.jsonl` was **re-extracted at generation close** and now holds
**98 rows** (`beforeSubmitPrompt` 1 · `postToolUse` 92 · `afterFileEdit` 4 · `stop` 1) instead of the
80-row mid-session snapshot quoted in the main log. Secret check re-run: no `ATATT…` token and no
e-mail literal in `comments/artifacts/fineso/` — the only `ATATT` string on disk is the *search
pattern* inside a recorded Shell command, not a credential.
