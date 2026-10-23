# Session log — 2026-10-22 · agent env-check on consumer `atrievefin`

> **Status:** verified evidence. Every statement below is either reproduced by a command in
> [`./agent-session-2026-10-22T1320Z/turn.jsonl`](./agent-session-2026-10-22T1320Z/turn.jsonl)
> (23 raw hook rows) or by a command quoted inline.
>
> **Location:** `harness-eso/comments/artifacts/atrievefin/` — a review artifact for upstream, **not**
> part of the documentation pack in `documents/`. It describes one session against one consumer; it
> is not a statement about how the system is designed.
>
> **What this is for:** the product owner reads this to learn what harness-eso actually *did* on a
> European/vertical consumer that was provisioned the same day — what it produced, what looked
> wrong at first glance but was not, and what the agent itself did badly. Written **by the agent**
> that ran the session, including its own defects (§5).

| Field | Value |
|---|---|
| Consumer | `atrievefin` (`../atrievefin`) — vertical Education consumer of FinESO, `profile: generic-eso` |
| Consumer class | `question` / env check — **read-only**, no product code edit, no protected write |
| Observe plane | Docker container, `http://127.0.0.1:8795` (started `2026-10-22T13:02:18Z`, uptime 1144 s at probe) |
| Harness tree exercised | Cursor (`.cursor/`) — `.agents/` (Antigravity) **configured but idle for this repo** |
| Session / conversation | `dc4602aa-f2ab-44db-8c2c-265e9a7330e3` |
| Generation (turn, `beforeSubmitPrompt`) | `8979ccee-7428-4c70-b923-44ee34a93607` |
| Model id (hook-reported) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` (`stop` row; `model: "unknown"`) |
| Trace window | `route-trace.jsonl` rows for the generation, `13:20:58Z → 13:22:16Z` |
| Tool mix | 18 Shell · 2 Read · 1 `MCP:codegraph_explore` · 2 lifecycle rows — **0 Write** |
| Outcome | runtime **PASS**, consumer maturity **T2** (`pass=18 fail=7 criticalFail=0`), ESO **correctly failed closed** on write |

Prompt (verbatim, `beforeSubmitPrompt`):

```
tao muốn kiểm tra môi trường harness-eso đang được áp dụng sửa dụng cho atrievefin

chỉ kiểm tra, không sửa code
```

Injected at turn start by the IDE: `core.law-gate.mdc`, `core.pipeline-gate.mdc`,
`core.conversation-hygiene.mdc`, `core.scope-fallback.mdc`, `CLAUDE.md`, `AGENTS.md`;
`decisionEventTypes: ["turn_start","route_attach"]`.

---

## 1. What the runtime produced

### 1.1 Preflight at turn start (`13:20:59Z`, latency **952 ms**)

`.cursor/session/.eso-preflight.json`:

```json
{ "ok": true, "cognitiveState": "STALE", "domain": "tools", "contractMissing": true,
  "allowWrite": false, "level": "insufficient", "score": 0,
  "mode": "hint", "enforceWrites": "fail_closed", "brainTierHint": "flash",
  "pinnedInvariants": [],
  "gaps": [ { "kind": "law", "query": "harness-tooling",  "priority": 1 },
            { "kind": "law", "query": "decision-facade",  "priority": 1 },
            { "kind": "law", "query": "harness-eso",      "priority": 1 },
            { "kind": "code", "query": "need at least 1 file read(s); have 0", "priority": 2 } ] }
```

Bundle stamp (verdict mirror, `13:20:59Z`):

```json
{ "ok": true, "allowWrite": false, "level": "insufficient", "score": 0,
  "mode": "fail_closed", "enforceWrites": "fail_closed" }
```

### 1.2 Gap closure (snapshot `13:24Z`, i.e. during the **follow-up** turn)

```json
{ "preflightAt": "2026-10-22T13:24:06Z",
  "requiredGapIds": ["law:harness-tooling","law:decision-facade","law:harness-eso",
                     "code:need at least 1 file read(s); have 0"],
  "closedGapIds":   ["law:harness-eso","code:need at least 1 file read(s); have 0"],
  "allClosed": false }
```

Note the closure was triggered by `Read` calls into **`../harness-eso/comments/artifacts/`** — not
into `atrievefin` itself. `law:harness-tooling` and `law:decision-facade` stayed open even after the
agent probed the sidecar and read `AGENTS.md` + `.harness/decision-policy.json`. Same shape as the
`x79` session finding **F-C**: the tracker seems to evaluate only preflight → first tool round.
See §2 F-3.

### 1.3 Observe plane — `GET /health` (`13:22Z`)

```json
{ "ok": true, "degraded": false, "enabled": true,
  "db": "/data/observe/atrievefin/harness.db",
  "ingestSpine": { "spineOk": true,
                   "transcriptDir": "/host-cursor/projects/Users-thangs2net-Workspaces-atrievefin/agent-transcripts",
                   "transcriptDirExists": true, "transcriptFiles": 6,
                   "requestCount": 69, "warnings": [] },
  "lastIngest": { "ok": true, "changed": true,
                  "counts": { "requests": 69, "calls": 1380, "events": 3237, "conversations": 14 },
                  "gate": { "inserted": 0, "skipped": 63, "stored": 12 } },
  "ingestOwner": ["worker"], "startedAt": "2026-10-22T13:02:18Z",
  "uptimeSec": 1144, "revision": 201, "turns": 37, "events": 1447 }
```

Only `/health` was probed on the sidecar this session (`/status` returned non-JSON through the
sandbox; `/api/status`, `/api/eso`, `/api/consumers` → 404). The UI/API surface was **not** exercised
here — it was already exercised on `x79`.

### 1.4 Consumer maturity at session time

`.harness/diagnostics/latest.md` (`13:02:47Z`), standard **consumer-maturity v1.2.0**:

```
tierReached   T2
summary       pass=18 fail=7 criticalFail=0
FAIL WARN T3.1 00.context-contract.json present
FAIL WARN T3.2 Agent manifests zone present
FAIL INFO T3.3 eso-coverage.json scorecard
FAIL INFO T4.1 Engineering *-runtime agents (Cursor)
FAIL INFO T4.3 Engineering skill (*engineering*) present (Cursor)
FAIL INFO T4.5 Dual-harness verify script
FAIL INFO T5.1 jira-impl.sh present (optional lane)
```

T0 / T1 / T2 fully pass. **No CRITICAL failure.** Compared with `x79` (`pass=19 fail=6`): `atrievefin`
fails **T4.1** extra (no `.cursor/agents/`) and, unlike `x79`, **passes T3.4** (`docgraph.scope`
already lists `path:SDLC/00.agent-manifests`) — a path that does not exist yet, see F-6.

---

## 2. Runtime findings — expected vs. actual

| # | Observation | Verdict |
|---|---|---|
| **F-1** | Sidecar writes **`/data/observe/atrievefin/harness.db`** (inside the container volume) while `harness.config.json` declares `storage.sqlite.path: ".harness/harness.db"` — and no `.harness/harness.db` exists on the host | **Expected wiring, undocumented consequence.** The consumer config is what the *hook* path reads; the container mounts its own DB path. But the declared path is a dead letter on the host, and deleting the container drops the whole observe history. Worth a line in the consumer config docs. |
| **F-2** | `preflight.mode: "hint"` yet `enforceWrites: "fail_closed"` in the same stamp, and `allowWrite: false` at `score 0` | **By design and correct here.** The user said *"chỉ kiểm tra, không sửa code"*; ESO made that mechanically true — every `Write`/`StrReplace` in this and the next turn was gated. Mode `hint` (advisory surface) + `fail_closed` (write enforcement) is a combination the console should render explicitly, because the word "hint" reads as "no enforcement". |
| **F-3** | `allClosed: false` although `law:harness-tooling` evidence (`--help` of `docgraph`/`codegraph`, `.harness/*` contents) *was* read in the same turn | **Open product question, now seen on a 2nd consumer.** Either the closure window is one-shot by design (then rename `allClosed` → `allClosedAtFirstRound`), or later reads are never re-evaluated. Reproduces `x79` F-C. |
| **F-4** | `code` gap said *"have 0 file read(s)"* while the very first action of the turn was `Read AGENTS.md` | **Expected:** the probe fires at `beforeSubmitPrompt`, *before* any tool call. But the wording reads as an accusation ("you read nothing"), when it means "at turn start". Suggest `"have 0 (turn start)"`. |
| **F-5** | `.agents/session/` is **empty**, `.agents/` has no `route-trace.jsonl`, yet `harness.config.json` ingests the `agents` tree with full parity (`preflight`, `guard-shell`, `guard-brain`, `observe`, `route`) | **By design:** the Antigravity tree was provisioned but never ran on this repo. Not a defect — but the install state cannot distinguish "provisioned and healthy" from "provisioned and never exercised". |
| **F-6** | `docgraph.scope` lists `path:SDLC/00.agent-manifests`, the directory does not exist; `T3.4` counts it as **PASS** | **Consumer-side drift, harness check too lenient.** `T3.4` verifies the *scope line*, not the *directory*. Compare `x79`, which fails T3.4 because its scope line is missing — so T3.4 rewards writing a line, not the zone. Consider gating T3.4 on path existence. |
| **F-7** | `.harness/WORKFLOW_GUIDE.md` is present and `T1.1` passes, while the same directory also holds a **generated** `host-install-state.json` (8.4 KB) that is rewritten on every `harness` host apply | **Expected** (`host-install-state` is a state file, not a doc) — noted only so nobody diffs it by hand. It *is* tracked by git, unlike `.harness/*` generally. |

### 2.1 Secrets found on the consumer (not harness-eso's bug, but in scope of "how is the env configured")

`.cursor/mcp.json` **and** `.mcp.json` both contain a **plaintext Atlassian API token** plus
`NODE_TLS_REJECT_UNAUTHORIZED: "0"`. `git status` shows `.cursor/mcp.json` is tracked and `.mcp.json`
is untracked-but-present at repo root. Neither is covered by harness-eso's
`decision-policy.paths.gated` (which gates `.cursor/mcp.json` for **writes** only) or by any
deny-read pattern seen in this session. The agent did **not** print the token into its answer, but it
did `cat` both files into its own context — see §5 A-2.

---

## 3. Hook contract actually observed

The 23 rows for generation `8979ccee…` carry, consistently:

```
at · pid · event · tool · path · attachments · ruleFiles · fileAttachments · keys · payload · harness
```

Events: `beforeSubmitPrompt` ×1 · `postToolUse` ×21 · `stop` ×1 — the same shape as `x79`.

- `beforeSubmitPrompt` carries the **verbatim prompt** and the injected rule list
  (`core.law-gate.mdc`, `core.pipeline-gate.mdc`, `core.conversation-hygiene.mdc`,
  `core.scope-fallback.mdc`, `CLAUDE.md`, `AGENTS.md`).
- `postToolUse` rows carry `tool: "Shell"` with **empty `path`**, so a per-file census of shell work is
  impossible without parsing `tool_input.command` out of `payload`. Consistent with `x79`, still a
  rough edge for any "which files did the agent touch" report.
- MCP tools appear as `MCP:codegraph_explore` (1 row) — the `deepseek-direct` and `jira` servers were
  never called, so `guard-brain` never fired.
- `stop` carries `status: "completed"`, `input_tokens: 388009`, `output_tokens: 4534`,
  `cache_read_tokens: 349696`.
- Every row carries `user_email` and `workspace_roots`; the committed copy redacts `user_email` only.

---

## 4. Reproduction

```bash
# runtime health (consumer port is 8795, not 8792)
curl -s http://127.0.0.1:8795/health | jq '{ok,degraded,uptimeSec,lastIngest}'

# which ports the stack actually holds
lsof -nP -iTCP:8795 -sTCP:LISTEN
lsof -nP -iTCP:3311 -sTCP:LISTEN   # agentmemory
lsof -nP -iTCP:3313 -sTCP:LISTEN   # agentmemory viewer

# host pack integrity — hashes must equal .harness/host-pack/host-pack.json
shasum -a 256 .harness/host-pack/{harness-hook.mjs,route-hook.py,path-policy.default.json}

# hook sanity without touching product files
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node .harness/host-pack/harness-hook.mjs --hook guard-shell --tree cursor
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | python3 .cursor/hooks/guard-shell.py

# adapters present?
codegraph --version ; docgraph --q "evidence rubric preflight" --top 3

# this turn from the hook trace (consumer side)
grep '8979ccee-7428-4c70-b923-44ee34a93607' .cursor/session/route-trace.jsonl | jq -r '[.at,.event,.tool] | @tsv'
```

Adapter binaries: `docgraph` and `codegraph` both at `~/.local/bin`, `codegraph 1.6.2`.
No `harness` / `harness-eso` binary is on `PATH` for the consumer — lifecycle is driven through
`harness.config.json` + hooks only.

---

## 5. Agent self-audit — defects in *this* session

| # | Defect | Cost | Proposed guard |
|---|---|---|---|
| **A-1** | `cat .mcp.json` and `.cursor/mcp.json` in full, printing a **live Jira API token** into the agent context and into the shell transcript | Secret material entered model context. The answer did *not* repeat it, but the transcript holds it | Read config files with a redactor (`jq 'del(..|env.JIRA_*)'` or `sed 's/ATATT[^"]*/<redacted>/'`); or deny-read patterns on `*mcp.json` env blocks |
| **A-2** | Ran `python3 -m json.tool .cursor/session/.eso-preflight.json` and then **re-probed the same preflight** in the next turn — two near-identical probe rounds | ~6 duplicate Shell calls across the two turns | Read `.eso-preflight.json` once at turn start and quote it; the file is rewritten by the hook, so re-read only after a new generation id |
| **A-3** | `docker ps` attempted although the agent sandbox cannot reach the docker socket (`permission denied ... unix:///Users/thangs2net/.docker/run/docker.sock`) | 1 wasted call | Probe Docker only when container work is in scope; use `curl` on the published port instead (the sidecar `/health` answered while Docker CLI did not) |
| **A-4** | First write attempt to `../harness-eso/comments/artifacts/atrievefin/` used plain `mkdir` and was stopped by the **sandbox** with `Operation not permitted` — not by ESO. Second attempt with `required_permissions: all` was then stopped by **auto-review** | 2 blocked calls + 1 approval prompt | Predict the write target before acting: if it is outside the workspace, request permission on the *first* attempt and say why |
| **A-5** | `/status` probed with a JSON parser without checking content type; took a 2nd call to conclude "non-JSON through the sandbox" | 1 wasted call | `curl -I` the endpoint list before parsing |
| **A-6** | Never ran `./verify-consumer.sh atrievefin` (available in `../harness-eso/`) — quoted the **stale** `.harness/diagnostics/latest.md` from 18 min earlier as the maturity verdict | Verdict could have drifted | Treat `diagnostics/latest.md` as a snapshot; re-run `verify-consumer.sh` when the log is going to be persisted (§1.4 is therefore marked *"at session time"*) |

---

## 6. OPEN — not tested

1. `./verify-consumer.sh atrievefin` re-run at write time (see A-6) — the committed
   `consumer-maturity-latest.md` is the consumer's own 13:02Z copy, not a fresh run.
2. Observe API / console UI against project `atrievefin` (`/api/requests`, `/api/decisions`,
   `/api/gate/summary`) — only `/health` was read; `x79` already covered the surface.
3. `eso.enforceWrites: fail_closed` actually **rejecting** a protected write on this consumer
   (would require attempting a gated write; deliberately not done — the user asked read-only).
4. The `.agents/` (Antigravity) path: hooks are installed but never fired on this repo.
5. `harness.config.json` `memory.adapterId: "noop-memory"` while `.cursor/rules/core.conversation-hygiene`
   demands `memory_smart_search` at turn start and `memory_save` at closure — the rule is
   **not enforced by the harness** on this consumer. Whether AgentMemory (alive on `:3311`) is meant
   to be wired here is a product/config decision, not an agent one.

---

## 7. Artifacts in this folder

| File | Content |
|---|---|
| `agent-session-2026-10-22T1320Z/turn.jsonl` | 23 raw `route-trace.jsonl` rows for generation `8979ccee…`, unmodified **except** `user_email` → `"<redacted>"` in all 23 rows |
| `agent-session-2026-10-22T1320Z/eso-preflight.json` | preflight verdict as written by the hook (turn 1, `13:20:59Z`) |
| `agent-session-2026-10-22T1320Z/eso-gap-closure.json` | gap closure as written by the hook (`13:24:37Z`, turn 2) |
| `agent-session-2026-10-22T1320Z/eso-bundle-stamp.json` | verdict mirror as written by the hook |
| `agent-session-2026-10-22T1320Z/consumer-maturity-latest.md` | consumer's `.harness/diagnostics/latest.md` at `13:02:47Z` (see §6.1 — not re-run) |

Redaction rationale: identical to `../x79/`. Raw rows carry `user_email` and `workspace_roots` on
every event; the committed copy strips the e-mail only. Prompts, paths and tool names are kept
verbatim because they are the evidence. The Jira token (§2.1, §5 A-1) was printed by `cat` into the
`postToolUse` **output**, which `route-trace.jsonl` does **not** store — so it is **not** in
`turn.jsonl`. It *did* enter the model context.

Consumer-side originals (authoritative, may be rewritten by later turns):
`../atrievefin/.cursor/session/{route-trace.jsonl,.eso-*.json}` and `../atrievefin/.harness/diagnostics/latest.md`.
