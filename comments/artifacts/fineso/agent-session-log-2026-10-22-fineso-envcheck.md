# Session log — 2026-10-22 · agent env-check on consumer `fineso`

> **Status:** verified evidence. Every statement below is either reproduced by a command in
> [`./agent-session-2026-10-22T1324Z/turn.jsonl`](./agent-session-2026-10-22T1324Z/turn.jsonl)
> (re-extracted at generation close — **98 rows**; the mid-session snapshot quoted in §5 has 80)
> or by a command quoted inline. **Two claims in this log were corrected in
> [`./agent-session-log-2026-10-22-fineso-envcheck-addendum.md`](./agent-session-log-2026-10-22-fineso-envcheck-addendum.md):
> the eager-rule "PASS" (§3 F-14 / A-8) and the `stop` row absence (§5 OPEN-1).** Read the addendum
> with this file.
>
> **Location:** `harness-eso/comments/artifacts/fineso/` — a review artifact for upstream, **not**
> part of the documentation pack in `documents/`. It describes one session against one consumer; it
> is not a statement about how the system is designed.
>
> **What this is for:** the product owner reads this to learn what harness-eso actually *did* on the
> richest consumer (`fineso`, the only one at **T5**), what looked wrong at first glance but was not,
> and what the agent itself did badly. Written **by the agent** that ran the session, including its
> own defects (§6).

| Field | Value |
|---|---|
| Consumer | `fineso` (`../fineso`) — `:8794`, `profile: generic-eso`, `domain: financial-accounting` |
| Consumer class | `question` / env check — **read-only** on consumer source; one artifact write into `harness-eso` |
| Observe plane | Docker container, `http://127.0.0.1:8794` (started `2026-10-22T13:14:11Z`) |
| Harness tree exercised | **Both** — Cursor (`.cursor/`) live; Antigravity (`.agents/`) provisioned and inspected, but not driven |
| Session / conversation | `595973e2-ab40-408b-8e22-576ccf6b0d00` |
| Generation (turn, `beforeSubmitPrompt`) | `26c1faf8-b714-4415-b5d3-b1605f873f16` |
| Model id (hook-reported) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` (`payload.model: "unknown"`) |
| Trace window | `13:24:24Z → 13:29:56Z` |
| Tool mix | 54 Shell · 16 Read · 1 `MCP:memory_smart_search` · 1 lifecycle row — **0 Write, 0 StrReplace** |
| Outcome | consumer maturity **T5** (`pass=25 fail=0 criticalFail=0`), **but** `scripts/ci/verify-dual-harness.mjs` **FAIL (exit 1)** |

Prompt (verbatim, `beforeSubmitPrompt`):

```
tao muốn kiểm tra môi trường harness-eso đang được áp dụng sửa dụng cho fineso

chỉ kiểm tra, không sửa code
```

Injected at turn start by the IDE (`ruleFiles` row): `core.law-gate.mdc`, `core.pipeline-gate.mdc`,
`core.conversation-hygiene.mdc`, `core.workspace-isolation.mdc`, `core.scope-fallback.mdc`,
`fineso.engineering-slp.mdc`, `AGENTS.md` — **6 rules + law**, matching the `tokenDiet.maxEagerRules: 7`
budget exactly.

---

## 1. Verdict

harness-eso is **applied and healthy** on `fineso` at the highest tier the standard defines
(`consumer-maturity v1.2.0` has no T6), with a live observe plane, working guards and a firing
preflight. It is **not** clean: the consumer's own dual-harness CI gate is **red**, and three of the
harness's own contracts disagree with each other (§3 F-7, F-8, F-10). None of these block the
runtime; they block trust in "green means green".

## 2. What the runtime produced

### 2.1 Consumer maturity — re-run, not a snapshot

`../harness-eso/verify-consumer.sh fineso`, at session time (13:28Z):

```
verify-consumer  fineso
  root          /Users/thangs2net/Workspaces/FinESO
  standard      consumer-maturity v1.2.0
  tierReached   T5
  summary       pass=25 fail=0 criticalFail=0
  diagnostics   .../FinESO/.harness/diagnostics/latest.md
```

All 25 checks T0.1 → T5.4 PASS. Notable: `T0.4 Write guards present (both trees)` counts **file
existence**, and both trees do have `guard-write.py` — see F-8 for why that check is weaker than it
reads.

### 2.2 Preflight at turn start (`13:24:25Z`, latency **917 ms**)

`.cursor/session/.eso-preflight.json`:

```json
{ "ok": true, "cognitiveState": "STALE", "domain": "harness",
  "contractMissing": false, "allowWrite": false,
  "level": "insufficient", "score": 0.1833,
  "mode": "hint", "enforceWrites": "fail_closed", "brainTierHint": "flash",
  "pinnedInvariants": [], "surface": { "bucket": "tools" },
  "gaps": [ { "kind": "law", "query": "harness-tooling",        "priority": 1 },
            { "kind": "law", "query": "decision-facade",        "priority": 1 },
            { "kind": "code", "query": "need at least 1 file read(s); have 0", "priority": 2 } ] }
```

### 2.3 Gap closure (snapshot at write time, `13:30:39Z`)

```json
{ "preflightAt": "2026-10-22T13:24:25Z",
  "requiredGapIds": ["law:harness-tooling", "law:decision-facade",
                     "code:need at least 1 file read(s); have 0"],
  "closedGapIds":   ["law:harness-tooling",
                     "law:decision-facade",
                     "code:need at least 1 file read(s); have 0"],
  "allClosed": true,
  "toolUses": [ … 32 most recent … ] }
```

Both `law:` gaps closed when the agent ran `docgraph --q "…"` (the string `harness-tooling` /
`decision-facade` appears in the tool input). **`law:decision-facade` closed with a query that
returned zero useful documents** — F-3.

### 2.4 Observe plane — `GET /health` (`13:30Z`)

```json
{ "ok": true, "degraded": false, "enabled": true,
  "db": "/data/observe/fineso/harness.db",
  "startedAt": "2026-10-22T13:14:11Z", "uptimeSec": 966,
  "revision": 282, "turns": 71, "events": 1982, "clients": 0,
  "ingestSpine": { "spineOk": true, "transcriptDirExists": true,
                   "transcriptFiles": 34, "requestCount": 254, "warnings": [] },
  "ingestOwner": "worker",
  "lastIngest": { "ok": true, "changed": false, "idle": true, "ms": 614,
                  "counts": { "requests": 254, "calls": 4414, "events": 5772, "conversations": 35 },
                  "scope": "0 requests / 0 gens",
                  "gate": { "inserted": 0, "skipped": 75, "stored": 0 } } }
```

Same shape as `x79` / `atrievefin` F-1: the container writes `/data/observe/fineso/harness.db`, while
`harness.config.json` declares `storage.sqlite.path: ".harness/harness.db"` — **no `harness.db`
exists in `FinESO/.harness/`** (`ls .harness/*.db` → no matches). The declared path is a dead letter
on the host; the observe history lives only inside the container volume.

### 2.5 Host pack integrity — PASS

`shasum -a 256` of `harness-hook.mjs`, `route-hook.py`, `path-policy.default.json` equals every hash
declared in `.harness/host-pack/host-pack.json` (`version 0.1.0`, `builtAt 12:41:13Z`, refreshed
`13:20:30Z` by `host-bootstrap.json` with `hostPack.ok: true`, `failures: []`).

### 2.6 Adapters

| Adapter | State | Evidence |
|---|---|---|
| docgraph-cli | OK | `docgraph --q "INV-05 dual harness"` → hits incl. `SDLC/00.agent-manifests/01.domains/06.harness.spec.md`; `--print-harness` → `cursor via=cf-bundle (observed: cursor)` |
| codegraph-cli | OK | `codegraph 1.6.2`; daemon log: `File watcher active`, `Auto-synced 1 file(s) in 240ms` |
| agentmemory-mcp | **Reachable but useless here** | `:3311` LISTEN, viewer `:3313` → 200, `/health` → **404** (not exposed). `memory_smart_search("harness-eso dual-harness INV-05 FinESO consumer")` → **2 hits, both score ≈0.016**, both about `R0.3` bun-workspace decisions. See F-9 |
| deepseek-mcp (`guard-brain`) | Configured, never fired | 0 `ask_deepseek*` calls in the turn |

---

## 3. Runtime findings — expected vs. actual

| # | Observation | Verdict |
|---|---|---|
| **F-1** | Sidecar writes `/data/observe/fineso/harness.db`; consumer declares `.harness/harness.db`, which does not exist on the host | **Expected wiring, undocumented consequence** (identical on `atrievefin`). Deleting the container drops the entire observe history. |
| **F-2** | `mode: "hint"` and `enforceWrites: "fail_closed"` on the same stamp | **Correct, and it worked**: 0 Write calls this turn, `allowWrite: false` throughout. But "hint" reads as "no enforcement" while the write gate is closed. |
| **F-3** | `law:decision-facade` closed although `docgraph --q "decision-facade" --top 3` returned **two rows with score 0** and no body text | **Defect.** The closure test is substring matching on the tool input (`closesGap` → `hay.includes(target)`), so *mentioning* the gap term closes the gap regardless of whether law was retrieved. A query that returns nothing is indistinguishable from a query that answers. |
| **F-4** | Once all gaps closed, the stamp is rewritten with `score: Math.max(pre.score, 0.85)` (`harness-hook.mjs:879-885`) — i.e. `0.1833 → 0.85` purely by closure bookkeeping | **Defect (same family as F-3).** The score is not re-measured; it is clamped up to the pass threshold. An `85` produced this way means "the agent mentioned the right words", not "the evidence exists". |
| **F-5** | `code` gap text *"need at least 1 file read(s); have 0"* while the agent's first action was `Read .cursor/mcp.json` | **Expected** (probe fires at `beforeSubmitPrompt`), **wording is an accusation**. Suggest `"have 0 (turn start)"` — same note as `atrievefin` F-4, second consumer. |
| **F-6** | `codegraph_explore` (the MCP tool the rules demand) **cannot close the `code` gap** for consumer `fineso` when no gap token matches, but a plain `Read` can | **Gap-tracker blind spot** for MCP tools: `gapKindsForTool` adds `code` for `CODEGRAPH_RE` names, but the row lands in `route-trace` as `MCP:codegraph_explore`, which the regex set does not obviously cover. Two different "code recon" acts are treated unequally. |
| **F-7** | `fineso.config.json` → `governance.policyPath: "./.harness/decision-policy.json"`, and `.harness/decision-policy.json.paths` **replaces** the pack default wholesale (`guard-write.py:141-177`, "a declared list **replaces** the default rather than merging") | **Runtime hazard.** Deleting or emptying `paths.gated` silently un-gates `AGENTS.md`, `.cursor/rules/`, `.agents/rules/`, `guard-write.py` itself — with no warning. The replacement rule is documented in a code comment, not in the policy or the guide. |
| **F-8** | The two path policies **disagree** — measured, not inferred: `decision-policy.json.paths.gated` (22) vs `host-pack/path-policy.default.json.gated` (23). Only in the consumer: `.cursor/hooks/locked-paths.txt`, `.agents/hooks/locked-paths.txt`. Only in the default: `backend/mu-*`, `document/mu/`, `frontend/`. `locked`: `[]` vs `["document/mu/be/00.law/"]` | **Drift between two sources of truth for one rule.** Benign for `fineso` today (the three default-only prefixes are the sibling repo's), and the replacement rule means the guard reads the consumer list — but a structural check that compares the two lists would have caught F-7 before it bit. |
| **F-9** | `fineso.config.json` points AgentMemory at `:3311` (which is alive, `fineso.config.json.agentMemory.host`), while `.harness/integrations.json.memory.adapterId` is **`noop-memory`** (the pre-bootstrap dump; `harness.config.json` says `agentmemory-mcp`) | **Stale adapter record.** The live rule `core.conversation-hygiene` *commands* `memory_smart_search` at turn start; the harness does not enforce it, and when the agent did call it the recall was near-zero (scores 0.016) — memory is not actually feeding recon on this consumer. Same open question as `atrievefin` §6.5, now with a measured recall number. |
| **F-10** | `T0.4 "Write guards present (both trees)"` passes on **file existence**. In `.agents/`, `hooks.json` never names `guard-write.py`; it is invoked indirectly by `.agents/hooks/pre-tool-use.py:41`, matched on `"*"`. In `.cursor/`, `guard-write.py` is a first-class `preToolUse` entry with `failClosed: true` | **Check is weaker than it reads**, and the two trees gate writes by different mechanisms. If Antigravity changes `PreToolUse` payload shape, `pre-tool-use.py` can fail open (`allow()` on unparseable stdin) while `T0.4` stays green. |
| **F-11** | `scripts/ci/verify-dual-harness.mjs` exits **1** on the current tree: 7 × *"Found MDC file in .agents/rules/. Antigravity rules MUST end with .md"* | **Real INV-05 violation, live.** See §4 — this is the single concretely red gate on the consumer. |
| **F-12** | `verify-consumer.sh --project fineso` → `invalid flag`; `verify-consumer.sh /abs/path/to/FinESO` → `Unknown consumer` although the registry lists that exact root | **CLI rough edge.** Only the registry *id* works; a path that the tool itself prints as "Repo root" in the next invocation is rejected. Cost the agent one wasted call (§6 A-3). |
| **F-13** | `harness.config.json.ingest.harnesses` declares `.agents` with full parity (`preflight`, `route`, `guard-shell`, `guard-brain`, `observe`, `data-lake-watcher`), yet `.agents/session/` holds **only** the three `.eso-*.json` files — no `route-trace.jsonl` | **Provisioned but never exercised** for Antigravity, so `verify-dual-harness` (§4) has never been able to catch the drift under real Antigravity traffic. Same shape as `atrievefin` F-5. |

### 3.1 Secrets on the consumer (not a harness bug — but "how is the env configured")

`.cursor/mcp.json` (line 60-66, **tracked in git**) and the same block in the MCP server config carry a
**live Atlassian API token** in plaintext, plus `NODE_TLS_REJECT_UNAUTHORIZED: "0"`. `AGENTS.md` /
`decision-policy.json` do not put `*mcp.json` in any **deny-read** pattern — only `gated` for writes.
The agent `Read` this file in full (it was the file already open in the IDE, and is the natural first
probe for "which MCP servers are wired"). See §6 A-1.

---

## 4. The one red gate — INV-05 dual harness

```
$ node scripts/ci/verify-dual-harness.mjs ; echo "exit=$?"
[INV-05 Dual-Harness Violation] Antigravity rules violation: Found MDC file "core.conversation-hygiene.mdc" in .agents/rules/.
  … core.law-gate.mdc · core.pipeline-gate.mdc · core.scope-fallback.mdc ·
     delivery.workflow.mdc · workflow.agentic-factory.mdc · workflow.qc-runtime.mdc
exit=1
```

Seven `.mdc` files sit inside the Antigravity tree **next to** their `.md` twins. The `.md` twins are
the legitimate Antigravity rules; the `.mdc` copies are Cursor-format files that were copied into
`.agents/rules/` (all 7 have Cursor origins in the tracked diff at session start).

Worse than the format: **6 of 7 twins are not the same rule.** `diff` on
`core.law-gate.md` vs `core.law-gate.mdc`:

```diff
- version: "1.1.0"                 + version: "1.0.0"
- AGENTS.md as supreme law (INV-01..05)   + AGENTS.md as supreme law
-   4. core.workspace-isolation     (missing)
```

Only `core.scope-fallback` is byte-identical. Since Antigravity may load either extension depending
on version, the Antigravity agent can currently read **two different versions of the supreme law**.
Note the harness's own `provision` step did not create these (the `.mdc` files are consumer-side
copies) — but `verify-consumer.sh` cannot see it, because `T0.3`/`T0.4` only ask whether the trees
and guards exist.

---

## 5. Hook contract actually observed

`turn.jsonl` — 80 rows for generation `26c1faf8…`:

```
at · pid · event · tool · path · attachments · ruleFiles · fileAttachments · keys · payload · harness
```

- `events`: `beforeSubmitPrompt` ×1 · `postToolUse` ×79.
- `tools`: `Shell` 54 · `Read` 16 · `MCP:memory_smart_search` 1.
- `postToolUse` `Shell` rows carry an **empty `path`** — a per-file census of shell work needs
  `payload.tool_input.command`, exactly as on `x79` and `atrievefin`.
- `beforeSubmitPrompt` payload keys: `conversation_id, generation_id, model, model_id,
  composer_mode, prompt, session_id, hook_event_name, cursor_version, workspace_roots, user_email,
  transcript_path`. `model: "unknown"`, `model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017"`.
- **No `stop` row was written for this generation** within the trace window — unlike `x79`
  (1 `stop`) and `atrievefin` (1 `stop`) — while `hooks.json` declares a `stop` hook running
  `route --tree cursor` and `.harness/cost/pre-compact-latest.json` is from `2026-10-19`. Either
  `stop` fires after the snapshot or the cursor `stop` path is not landing; **cannot distinguish from
  a session that is still open** (see §7 OPEN-1).
- `pre-compact` has produced exactly **one** record ever (`2026-10-19T16:55:28Z`,
  `context_percent 93.76`, 240037/256000 tokens) — the hook works, it is just rare.
- This generation's prompt/`user_email` is redacted in the committed copy (`user_email` only).

---

## 6. Agent self-audit — defects in *this* session

| # | Defect | Cost | Proposed guard |
|---|---|---|---|
| **A-1** | `Read .cursor/mcp.json` in full — it is the **focused file in the IDE** and a reasonable first probe, but it carries a live Jira token. The answer never printed it; `route-trace.jsonl` does not store tool *outputs*, so it is not in `turn.jsonl` — it **did** enter model context | Secret in context | Redact `*mcp.json` `env` blocks on read (`jq 'del(..\|.JIRA_API_TOKEN?)'`); or a deny-read pattern for `*mcp.json` when the task is not MCP config |
| **A-2** | Ran `curl /health` on `:8794` three times (session start, mid, end) instead of once at start + once at write | 2 redundant Shell calls (~2 s) | `/health` is cheap; the real fix is to capture once when the report is written, and say which instant it describes |
| **A-3** | `verify-consumer.sh --project fineso` then `verify-consumer.sh /abs/path` before landing on `verify-consumer.sh fineso` | 2 wasted calls | Read the usage block (`sed -n '1,50p'`) before the second attempt — I had `--project` in front of me in the error text's own remediation and assumed the flag existed |
| **A-4** | `cd /tmp && … | node harness-hook.mjs --hook guard-shell … rm -rf .cursor/rules` as a probe — **blocked by the live hook itself** (`l1_shell_deny`) | 1 blocked call, and the probe was **shaped like an attack**: `cd` out of the repo then `rm -rf` a gated path. The deny was correct | Never probe a guard with a destructive string. Use a benign target (`ln -s`, `printf > /tmp/x`) or read `decide()` (`harness-hook.mjs:1504-1527`) and reason statically — which is what I did afterwards |
| **A-5** | Assumed `lint`/`bun test` were relevant to a read-only env check and never ran them | nil (correct) — but the four-greens rule in `delivery.agent-native` reads as unconditional | Carry an explicit "read-only session, no code touched ⇒ greens N/A" line in the report |
| **A-6** | `docgraph --version` failed (`unknown argument`) — docgraph has no `--version`; had to read its usage | 1 wasted call | Probe CLIs with `--help`/usage, not `--version` |
| **A-7** | Wrote the artifact set into `harness-eso` **after** the turn's gap closure was already `allClosed: true`, so the write went through on closure bookkeeping that I knew was weak (F-3/F-4) | Integrity concern | Do the recon first, then the write — or explicitly say the write is authorised by the **user's instruction**, not by the stamp |

---

## 7. OPEN — not tested

1. **`stop` hook on `fineso`** — no `stop` row in this generation's window. Re-check after the session
   closes; if it never lands, the cursor `stop` path is broken on this consumer (would be a new F-#).
2. `route-trace` rows for `.agents/` — zero exist. Whether `pre-tool-use.py` → `guard-write.py`
   actually denies a gated write under Antigravity is **unverified** (would need a real Antigravity
   turn; deliberately not simulated).
3. `eso.enforceWrites: "fail_closed"` actually **rejecting** a protected write on `fineso`. Not
   attempted: the user said read-only, and §6 A-4 shows the guard reverses the question — a probe
   looks like an attack.
4. `./harness token-diet` — the `harness` CLI is **not on `PATH`** for this consumer; the eager-rule
   count (6/7) was measured with `rg -l "alwaysApply:\s*true"`, not with the official linter.
5. Whether `.docgraph/docgraph.json` (mtime `2026-10-21T21:17`, same minute as `AGENTS.md`) has
   indexed the **current** `AGENTS.md`. `docgraph --q` works, but a stale index would explain why the
   two `law:` gap terms (`harness-tooling`, `decision-facade`) never return dense hits.
6. `codegraph_explore` as a gap-closer (F-6) — needs one turn whose preflight produces a `code` gap and
   whose only code recon is the MCP tool.

---

## 8. Artifacts in this folder

| File | Content |
|---|---|
| `agent-session-2026-10-22T1324Z/turn.jsonl` | 80 raw `route-trace.jsonl` rows for generation `26c1faf8…`, unmodified **except** `user_email` → `"<redacted>"` (rows and payloads) |
| `agent-session-2026-10-22T1324Z/eso-preflight.json` | preflight verdict as written by the hook (`13:24:25Z`) |
| `agent-session-2026-10-22T1324Z/eso-gap-closure.json` | gap closure as written by the hook (`at: 13:30:39Z`, `allClosed: true`, 32 retained `toolUses`) |
| `agent-session-2026-10-22T1324Z/eso-bundle-stamp.json` | verdict mirror as written by the hook |
| `agent-session-2026-10-22T1324Z/consumer-maturity-latest.md` | consumer's `.harness/diagnostics/latest.md` produced by the **re-run** in §2.1 (not a snapshot) |

Redaction rationale: identical to `../x79/`. Prompts, paths and tool names are verbatim because they
are the evidence. The Jira token (§3.1, §6 A-1) was read into model context but never printed into a
tool *output* that `route-trace.jsonl` stores, so it is **not** in `turn.jsonl`; it remains in the
consumer's tracked `.cursor/mcp.json`.

Consumer-side originals (authoritative, may be rewritten by later turns):
`../fineso/.cursor/session/{route-trace.jsonl,.eso-*.json}` and
`../fineso/.harness/diagnostics/latest.md`.
