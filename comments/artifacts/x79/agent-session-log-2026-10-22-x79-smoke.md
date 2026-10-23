# Session log — 2026-10-22 · agent smoke test on consumer `x79`

> **Status:** verified evidence. Every statement below is either reproduced by a command in
> [`./agent-session-2026-10-22T1245Z/turn.jsonl`](./agent-session-2026-10-22T1245Z/turn.jsonl)
> (43 raw hook rows) or by a command quoted inline.
>
> **Location:** `harness-eso/comments/artifacts/` — a review artifact for upstream, **not** part of the
> documentation pack in `documents/`. It describes one session against one consumer; it is not a
> statement about how the system is designed.
>
> **What this is for:** the product owner reads this to learn how an agent actually *behaves*
> against the ESO runtime — not what the runtime intends, but what it produced, what it got wrong,
> and what the agent itself did badly. Written **by the agent** that ran the session, including its
> own defects (§5).

| Field | Value |
|---|---|
| Consumer | `x79` (`../x79`) — dev consumer, `profile: generic-eso` |
| Consumer class | `question` / smoke-test — **no protected write**, no product code edit |
| Observe plane | Docker, `http://127.0.0.1:8792`, started `2026-10-22T12:42:03Z` |
| Harness tree exercised | Cursor (`.cursor/`) — `.agents/` (Antigravity) idle, 23 trace rows, none from this turn |
| Session / conversation | `e32047d0-66c5-448d-ace8-47848220c7fa` |
| Generation (turn) | `6365c392-f4f2-4a8e-966b-e9a504a5736d` |
| Model id (hook-reported) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Cursor version | `3.26.16` |
| Trace window | `route-trace.jsonl` lines **4023–4065**, `12:45:05Z → 12:48:02Z` |
| Tool mix | 22 Shell · 8 Read · 6 browser MCP · 2 memory_save · **0 Write** |
| Outcome | runtime **PASS**, consumer maturity **T2** (`pass=19 fail=6 criticalFail=0`), 3 items OPEN (§6) |

Prompt (verbatim, `beforeSubmitPrompt`):

```
test thử cái, test thử harness-eso
```

Injected at turn start by the IDE: `core.law-gate.mdc`, `core.pipeline-gate.mdc`,
`core.agent-pipeline.mdc`, `core.scope-fallback.mdc`, `AGENTS.md`;
`decisionEventTypes: ["turn_start","route_attach"]`; `transcript_path: null`.

---

## 1. What the runtime produced

### 1.1 Preflight at turn start (`12:45:05Z`, latency **613 ms**)

`.cursor/session/.eso-preflight.json`:

```json
{ "ok": true, "cognitiveState": "STALE", "domain": "tools", "contractMissing": true,
  "allowWrite": false, "level": "insufficient", "score": 0.3666666666666667,
  "mode": "hint", "enforceWrites": "off", "brainTierHint": "flash",
  "gaps": [ { "kind": "law",  "query": "harness-tooling", "priority": 1 },
            { "kind": "code", "query": "need at least 1 file read(s); have 0", "priority": 2 } ] }
```

Gap closure after the first `Read` (`12:45:10Z`):

```json
{ "requiredGapIds": ["law:harness-tooling", "code:need at least 1 file read(s); have 0"],
  "closedGapIds": ["code:need at least 1 file read(s); have 0"],
  "toolUses": [{ "tool": "Read", "path": "/Users/thangs2net/Workspaces/x79/AGENTS.md" }],
  "allClosed": false }
```

### 1.2 Kernel standalone — `POST /v1/preflight` (`12:45:41Z`, **33 ms**)

```json
{ "ok": true, "cognitiveState": "COLD", "conversationId": null,
  "level": "insufficient", "score": 0.3666666666666667,
  "allowWrite": false, "allowPromptSubmit": true,
  "esoMode": "hint", "enforceWrites": "off", "hardBlockers": [] }
```

→ The kernel answers with **no conversation context** and returns the same two gaps.
Same verdict, 33 ms vs 613 ms hook path: the hook path pays for transcript + law probe.

### 1.3 Observe plane

`GET /health` at `12:45:42Z` (uptime 219 s):

```json
{ "ok": true, "degraded": false,
  "db": "/data/observe/x79/harness.db",
  "ingestSpine": { "spineOk": true, "transcriptFiles": 73, "requestCount": 3225, "warnings": [] },
  "lastIngest": { "ok": true,
                  "counts": { "requests": 3225, "calls": 31072, "events": 4744, "conversations": 76 } } }
```

| Endpoint | Result |
|---|---|
| `/api/version` | `serverVersion 0.1.0`, `apiVersion 1`, `openapi-observe-v1.yaml` |
| `/api/project` | `x79`, `rootPath /data/repo`, `sentinelExists false`, watches `.cursor` + `.agents` + `.claude` |
| `/api/requests` | **3225**, `decisionVerdict` per row, grouped by conversation |
| `/api/calls` | per-call `toolNames`, `textChars`, `emitChars`, `estTokens` |
| `/api/decisions` | facade ledger — both `eso_insufficient` and `eso_sufficient` (`topProbability 1`) |
| `/api/aggregates` | hourly buckets back to `2026-08-11T14` |
| `/api/storage/status` | sqlite **41.9 MB**, 6450 ledger rows, blobs 0 B |
| `/api/workspace` | `x79` + `fineso`, `hostMode dual-ide`, `profile generic-eso` |
| `/api/ingest/run` | `ok:true changed:true`, **765 ms** |
| `/api/gate/summary` | **empty** — see §2 F-B |
| `/events` (SSE) | `hello` then `event: live`, 2 sources, `parseErrors 0`, `unassignedEvents 2` |
| UI `/requests`, `/decisions`, `/status` | render, real data |

### 1.4 Consumer maturity at end of session

`./verify-consumer.sh x79` (run from this repo, `2026-10-22T13:00:31Z`):

```
verify-consumer  x79
  standard      consumer-maturity v1.2.0
  tierReached   T2
  summary       pass=19 fail=6 criticalFail=0
  FAIL WARN T3.1 00.context-contract.json present
  FAIL WARN T3.2 Agent manifests zone present
  FAIL INFO T3.3 eso-coverage.json scorecard
  FAIL WARN T3.4 docgraph.scope lists Agent Zone path
  FAIL INFO T4.3 Engineering skill (*engineering*) present (Cursor)
  FAIL INFO T5.1 jira-impl.sh present (optional lane)
```

Full report: `../x79/.harness/diagnostics/latest.md`.
**No CRITICAL failure.** T0 (install) and T1–T2 (law/index/zones) fully pass on a real consumer —
the remaining failures are all T3+ documentation artifacts the consumer has not authored yet.

---

## 2. Runtime findings — expected vs. actual

| # | Observation | Verdict |
|---|---|---|
| **F-A** | `/api/requests` returned **no row** for the live turn, while SSE `live` already carried it (`6365c392…`) | **By design, but undocumented asymmetry.** `/api/requests` is fed by the host transcript spine (flushed later); `/events` is the live path. Operators comparing the two will think ingest dropped the turn. Document it; consider a `pending` badge in the Requests UI. |
| **F-B** | `/api/gate/events` → `{ "items": [], "total": 0 }` although this session *did* emit ESO decisions | **Expected for this consumer** (`eso.mode: hint`, `enforceWrites: off`): the gate trail records **blocked** writes only. Verify the Gate page says so, otherwise it reads as "broken". |
| **F-C** | `.eso-gap-closure.json` stays `allClosed: false` even though the `law:harness-tooling` evidence (`04.operations/*`, product `documents/`) was read four tool calls later | **Open product question.** The tracker appears to evaluate only **preflight → first tool round**. Either intended (cheap one-shot attestation → rename the field) or a real miss (later reads never re-evaluated). |
| **F-D** | `../x79/.harness/decision-policy.json` has `eso.preflight.enabled: **true**`, while `../x79/.cursor/rules/core.harness-consumer.mdc` states the consumer runs with `preflight.enabled: false` | **Doc drift on the consumer side.** Actual behaviour followed **enabled: true**. The x79 rule and the policy disagree; one of them is wrong. |

---

## 3. Hook contract actually observed

`postToolUse` rows for the same generation carry, consistently:

```
at · pid · event · tool · path · attachments · ruleFiles · fileAttachments · keys · payload · harness
```

- MCP tools are recorded as `tool: "MCP:<server>_<tool>"` (e.g. `MCP:browser_take_screenshot`).
- `Read` of a binary/screenshot still produces a `postToolUse` row with the PNG path — useful, but it
  means image reads inflate the tool census.
- `stop` fires as a real event and closes the turn (`12:48:02Z`).
- `beforeSubmitPrompt` carries the **verbatim** prompt and the injected rule file list — this is the
  only place in the trace where the prompt appears unredacted.

---

## 4. Reproduction

```bash
# runtime health
curl -s http://127.0.0.1:8792/health | jq '{ok,degraded,uptimeSec,lastIngest}'

# kernel standalone
curl -s -X POST http://127.0.0.1:8792/v1/preflight \
     -H 'content-type: application/json' \
     -d '{"userQueryStem":"test harness-eso smoke","turnId":"smoke-1"}' | jq '{level,score,allowWrite,gaps}'

# this turn from the hook trace (consumer side)
grep '6365c392-f4f2-4a8e-966b-e9a504a5736d' \
  ../x79/.cursor/session/route-trace.jsonl | jq -r '[.at,.event,.tool] | @tsv'

# consumer maturity
./verify-consumer.sh x79
```

---

## 5. Agent self-audit — defects in *this* session

Listed because the point of the log is behaviour, not a demo.

| # | Defect | Cost | Proposed guard |
|---|---|---|---|
| **A-1** | Read `installation/key.md` — plaintext DeepSeek / river / orca API keys — as the **second** action of the session, with no task need | Secret material entered model context and the transcript | Consumer hook deny-read on `**/key.md`, `**/*secret*`; **product**: extend `privacy.denyPathPatterns` (today: `.env`, `credentials`, `session/*.json`, `typesafe.env`) |
| **A-2** | `docker ps` attempted although the agent sandbox cannot reach the docker socket | 1 wasted call | Probe `docker info` only when Docker work is in scope |
| **A-3** | `memory_save` called without `content` → `Error: content is required`, retried 12 s later | 1 failed call | Read tool schema via `GetDynamicTools` before first use |
| **A-4** | 3 screenshots + 2 snapshots before the first screenshot was readable (`status: Loading requests…`) | ~4 redundant browser calls | Poll the backing `/api/...` until data exists, *then* capture |
| **A-5** | No `bun test`, no `./verify-consumer.sh` during the first pass — the maturity check was added only when asked to persist the log | coverage gap | Run consumer verification as part of any ESO smoke, not after |
| **A-6** | Attempted `./verify-consumer.sh ../x79` — script requires a **registry id**, not a path | 1 failed call + dependency on `required_permissions: all` for `mktemp` | Accept a path argument, or print registry ids in the error (it does print them, but the first line implies a path is valid) |

---

## 6. OPEN — not tested

1. `bun test` / `bun run test:observatory` in this repo.
2. `./harness up` / `observatory` lifecycle from CLI (`up`, `health`, `logs`) — the agent could only
   observe the already-running container.
3. `eso.enforceWrites: on` — whether the write guard actually blocks when `allClosed:false`
   (would require toggling consumer policy; not done unilaterally).

---

## 7. Artifacts in this folder

| File | Content |
|---|---|
| `agent-session-2026-10-22T1245Z/turn.jsonl` | 43 raw `route-trace.jsonl` rows for generation `6365c392…`, unmodified **except** `user_email` → `"<redacted>"` in all 43 rows |
| `agent-session-2026-10-22T1245Z/eso-preflight.json` | preflight verdict as written by the hook |
| `agent-session-2026-10-22T1245Z/eso-gap-closure.json` | gap closure as written by the hook |
| `agent-session-2026-10-22T1245Z/eso-bundle-stamp.json` | verdict mirror as written by the hook |

Redaction rationale: the raw hook row carries `user_email` and `workspace_roots` on every event;
the committed copy strips the e-mail only. Prompts, paths and tool names are kept verbatim because
they are the evidence. API keys were **not** captured in the trace (the agent read
`installation/key.md` via a tool call whose output is *not* stored in `route-trace.jsonl`) — but see
§5 A-1: the keys did enter the model context.

Consumer-side originals (authoritative, may be rewritten by later turns):
`../x79/.cursor/session/{route-trace.jsonl,.eso-*.json}`.
