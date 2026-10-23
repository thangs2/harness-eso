# Audit-diagnostic — `baplatform` · applied ESO environment (2026-10-23, read-only)

> **Status:** evidence. Every claim below is reproduced by a command quoted inline, or by a snapshot in
> [`./agent-session-2026-10-23T0328Z/`](./agent-session-2026-10-23T0328Z/) (31 raw hook rows, generation
> `a316c2da…`; `user_email` redacted, prompts/paths/tool names verbatim). Where I could not verify
> something (attestation MAC, live consent UX, in-container probe of the observe image) it is marked
> **NOT VERIFIED** rather than inferred.
>
> **Location:** `comments/artifacts/` — a review artifact for upstream, **not** documentation (`documents/`),
> not law, not install instruction. If this file and the code disagree, **the code is right**.
>
> **Scope:** read-only audit of the harness-eso environment applied to consumer `baplatform`. **No product
> code was edited**, no consumer file was mutated except the consumer's own session state that the host's
> ESO hooks write on their own (`preflight`, `gap-closure`, `bundle-stamp`). Writes were limited to
> (a) this artifact folder. Consumer-side fixes are listed as *direction only* — per consumer policy the
> upstream fix belongs in `harness-eso`, then a host-pack refresh on the consumer.

| Field | Value |
|---|---|
| Consumer | `baplatform` (`/Users/thangs2net/Workspaces/baplatform`) — ABP monolith + `apps/web`, dual-IDE |
| Consumer class | `question` / audit-diagnostic — no protected write, no product code edit |
| Session / conversation | `f003060f-ac7b-4e09-82c6-b0598c1f5684` |
| Generation (turn) | `a316c2da-a7ee-4f8c-b3ad-59a240d7c34d` |
| Trace window | `2026-10-23T03:28:38Z → 03:34Z`, 31 rows for the generation |
| Harness trees | Cursor exercised · Antigravity (`.agents/`) **inspected, idle since 2026-10-19** |
| Host pack installed | v0.1.0, `builtAt 2026-10-22T15:43:07Z`, `harness-hook.mjs` `791ec8cc…` (118,901 B) |
| Host pack upstream dist | v0.1.0, `builtAt 2026-10-23T03:09:59Z`, `harness-hook.mjs` `32435c89…` (119,552 B) — **newer, not deployed here** |
| Profiles / bootstrap | `cursor-superset` + `agents-superset`, `appliedAt 2026-10-22T16:03:23Z` |
| Observe plane | Docker `harness-observatory-baplatform-observe-server-1`, `127.0.0.1:8793 → 8790`, `healthy` |
| Consumer maturity | **T5**, `pass=25 fail=0 criticalFail=0`, standard `consumer-maturity v1.2.0` (2026-10-22T12:49:41Z) |
| Model id (hook-reported) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Outcome | 4 runtime findings (F-01…F-04), 1 host-pack rollup finding (F-05), 2 consumer-config findings (F-06…F-07), 4 agent self-defects (A-1…A-4) |

Prompt (verbatim, `beforeSubmitPrompt`):

```
baplatform tao muốn kiểm tra môi trường harness-eso đang được áp dụng sử dụng cho baplatform

chỉ kiểm tra, không sửa code.

audit-diagnostic only
```

---

## 1. Verdict

The environment **is applied, is the most mature consumer on this machine (T5), and is functional** —
hooks fire on both trees, the observe plane is up, the Evidence-Sufficiency cycle ran end-to-end inside
this turn. It is **weaker than its own configuration claims** in four places, and **one of its two IDE
trees is running a stale host pack**.

- ESO closed both gaps this turn and flipped the verdict `insufficient / 0.00` → `sufficient / 1.00`
  (§1.2). The flip is **real**: the closing tool inputs do carry the gap terms, and the staged writes
  (`.eso-gap-closure.json` → `.eso-bundle-stamp.json` → `~/.harness/attest/baplatform.json`) are
  consistent and monotone. This is *not* the "closure bookkeeping" shape seen on `x79`/`finESO`.
- But the gap that was closed was **not the gap the consumer meant to raise**: law gaps are semantic, and
  closure is decided on **filenames**. A `docgraph.json` index copy under `.harness/` — or, in the
  `2026-10-22` session, a path in a *different repo* — closes `law:pipeline-gate` equally well (F-01).
- The evidence chain that feeds the gate is only as fresh as an index nobody rebuilds: the consumer's
  docgraph snapshot is **4 days and 27 changed files** old, and it cannot answer its own primary law query
  (F-02).
- `memory` is declared **`noop-memory`** while an AgentMemory instance for this project is running
  (F-03) — so the gate can never ask for memory evidence.
- `.agents/` is inert: its trace stops at `2026-10-19T09:55Z` and its host pack is a version behind
  (F-05), while its `guard-shell.py` is a *different file* from the Cursor one (F-06, 3 missing flushes).
- Gated paths have **no consent record for this project at all**, and the log shows the gate actually
  denied a consumer rule edit on 2026-10-22 (F-07).

None of these blocks the consumer today. F-01 + F-03 make the gate's answer weaker than it reads;
F-05 + F-06 mean half of the declared dual-IDE surface is not running the code it claims.

---

## 2. What the runtime actually did in this session

### 2.1 Preflight at turn start (`03:28:38Z`, latency 480 ms)

`.cursor/session/.eso-preflight.json` (`agent-session-2026-10-23T0328Z/eso-preflight.json`):

```json
{ "ok": true, "cognitiveState": "STALE", "pinnedInvariants": [], "domain": "default",
  "contractMissing": false, "allowWrite": false,
  "level": "insufficient", "score": 0, "mode": "hint", "enforceWrites": "fail_closed",
  "brainTierHint": "flash", "surface": { "bucket": "tools" },
  "gaps": [ { "kind": "law", "query": "pipeline-gate", "priority": 1 },
            { "kind": "code", "query": "need at least 1 file read(s); have 0", "priority": 2 } ],
  "verdict": { "allowPromptSubmit": true, "allowProtectedWrite": false,
               "hardBlockers": [], "esoMode": "hint", "jevOnPartial": false } }
```

`domain: "default"` and `pinnedInvariants: []` on a consumer whose T3.1/T3.2/T3.3 checks all pass
(`sdlc/00.governance/00.context-contract.json`, `sdlc/00.agent-manifests/`, `.harness/eso-coverage.json`)
— same shape as `baplatform` D9 (2026-10-22) and `x79` D9. Still open, still unexplained: invariant
detection does not appear to run on the hook path.

### 2.2 Closure (`03:29:02Z` → `03:30:56Z`)

Three snapshots show a **staged, monotone** verdict — the exact fix `H3` asked for in
`eso-gap-io.mjs:352` ("rewrite the stamp on **every** transition"):

| At | File | level | score | allowWrite | closed |
|---|---|---|---|---|---|
| `03:28:38Z` | `eso-preflight.json` | `insufficient` | `0` | `false` | — |
| `03:29:02Z` | `eso-bundle-stamp.json` | `partial` | `0.45` | `false` | 1 / 2 (`code`) |
| `03:30:56Z` | `eso-gap-closure.json` + `eso-bundle-stamp.json` | `sufficient` | `1.0` | `true` | 2 / 2 (`law:pipeline-gate`) |

`~/.harness/attest/baplatform.json` follows: `level: sufficient`, `score: 1`, `allowWrite: true`,
`ttlSec: 600`, MAC present (MAC **NOT VERIFIED** — I did not read `.attest_secret`).

Closing tool uses (verbatim from `.eso-gap-closure.json`, 22 rows):

```
Read  /Users/thangs2net/Workspaces/baplatform/AGENTS.md                # law gap still OPEN after this
MCP:memory_smart_search  (no path)                                     # law gap still OPEN
Shell  (no path)                                                       # law gap still OPEN
MCP:memory_smart_search  (no path)
Shell  (no path)                                                       # ← law gap CLOSES here
```

The Shell command in that row was a **docgraph query**, and the argument blob contained the literal
`pipeline-gate`. That is `closesGap → stemMatches → stemHaystack` deciding on the **haystack when no file
path is present** (`eso-gap-io.mjs:239-241, 293-302`). It is a legitimate closure under the current rule
and an illegitimate one by intent: `docgraph.ts`, `harness-hook.mjs`, `core.pipeline-gate.mdc` and a
directory under `../harness-eso` are all the same evidence to it (F-01).

### 2.3 Observe plane

`docker ps` → `harness-observatory-baplatform-observe-server-1  e20d647be778  0.0.0.0:8793->8790/tcp  Up (healthy)`.

`curl http://127.0.0.1:8793/health` → **`000`**; `/healthz` → **`200`, `text/html`, `<title>Harness Observatory</title>`**.
The static UI answers, the documented health path does not (F-04). I did **not** run further probes into
the image (`docker exec … wget` timed out → probe inconclusive, *not* evidence of a fault).

### 2.4 Consumer maturity (snapshot, not re-run)

`.harness/diagnostics/latest.md` at `2026-10-22T12:49:41.724Z`, standard `consumer-maturity v1.2.0`:
**T5**, `pass=25 fail=0 criticalFail=0`. This is the consumer's own report, copied — **not** a fresh
`verify-consumer.sh baplatform` run in this session. Treat it as a claim at that timestamp, not as
current state (A-4).

---

## 3. Findings

### F-01 — law-gap closure accepts any haystack containing the term (MED, over-crediting)

`packages/harness-host-generic/src/eso-gap-io.mjs:239-302`:

```js
function stemHaystack(toolInput, toolName) {
    const filePath = extractFilePath(toolInput);
    if (filePath) return foldStem(String(filePath).split(/[\\/]/).pop());
    return foldStem(JSON.stringify(toolInput || {}));   // ← whole argument blob
}
…
if (`-${hay}-`.includes(`-${foldedTarget}-`)) satisfied = true;
```

The `foldStem`/`pathStems` fix (H1) correctly makes `Read core.pipeline-gate.mdc` close `pipeline-gate`.
The branch it did **not** narrow is the no-path branch: any Shell/MCP payload whose JSON contains the
token closes a semantic law gap. Observed closures on this consumer:

| Session | Closing tool input | Does it prove the law was read? |
|---|---|---|
| 2026-10-23 (this) | `Shell`: `docgraph.scope … grep pipeline-gate` (a `rg` over the scope file's own comment) | **no** — matched the word in a comment block |
| 2026-10-22 (D1) | `Read …/harness-eso/...` (different repo) | **no** |
| candidate | `Read .harness/cache/docgraph/…docgraph.json` (this session's hashed query text carries the term) | **no** |
| 2026-10-22 (D1) | `Read .cursor/rules/core.pipeline-gate.mdc` | **yes** |

**Why it matters:** `allowWrite` is computed from this set, and `guard-write.py` reads the attestation.
A consumer can be `sufficient` without any build agent having read the gate it is being asked to obey.

**Direction (pack):** on the no-path branch, restrict to *tool arguments that name an artifact* —
`Grep {pattern}` only when the pattern is the target itself (not a substring of a longer pattern),
`docgraph {query}`, or a path-like token inside the command (`.cursor/rules/core.pipeline-gate.mdc`).
A bare mention of the term in an unrelated command or a `jq`/`rg` over harness state should not close it.
Keep the exact-stem path match as-is.

**Direction (consumer):** the `tools` pack's `lawQueries: ["pipeline-gate"]` is correct and should not be
changed — this is a pack defect, not a consumer term defect.

### F-02 — the law evidence chain is stale, and the gap closes on a stale copy (MED, consumer + pack)

Consumer docgraph snapshot `.docgraph/docgraph.json`: `generated_at` **2026-10-19T16:52Z**.
Files changed after it (same scope): **27** `.md`/`.mdc` — all of
`sdlc/00.agent-manifests/02.jira-waves/*.spec.md`, the wave ticket maps, `sdlc/08.wbs/…`.

Two consequences, both reproduced:

1. The snapshot **cannot answer its own primary law query**. `docgraph --q "pipeline-gate preflight ESO write gate" --top 3 --repo .`
   returns `.cursor/instructions.md` only — `core.pipeline-gate.mdc` is absent from the top 3. A second
   query (`--q "core.ap-platform Antipatterns ABP monolith" --top 5`) does return `core.ap-platform.mdc`
   (rank 1) and `core.pipeline-gate.mdc` (rank 5, `score 1`). So the index contains the rule but ranks it
   last for the query that names it — either way the law gap named `pipeline-gate` is not reliably
   answerable from this snapshot.
2. The docgraph cache under `.harness/cache/docgraph/` holds **query text and snippets**. A `Read` of that
   cache therefore closes `law:pipeline-gate` without touching the rule (F-01 synergy) — the gate can be
   paid by reading the gate's own cache.

**Direction (pack):** exclude `.harness/**` (and other harness-state dirs) from law-gap evidence, mirroring
what `isProjectSourcePath` already does for code gaps (`NON_SOURCE_SEGMENTS`, `eso-gap-io.mjs:59-71`).
**Direction (consumer):** rebuild the docgraph index as part of the provision/verify step, not on the
operator's memory. A consumer whose law index is older than its newest rule file should read as
`insufficient` with a named remedy, not as `partial`.

### F-03 — `memory` is `noop-memory` while an AgentMemory for this project is running (MED, consumer config)

`.harness/integrations.json`:

```json
{ "law": { "adapterId": "docgraph-cli" }, "code": { "adapterId": "codegraph-cli" },
  "memory": { "adapterId": "noop-memory" }, "brain": { "adapterId": "deepseek-mcp" } }
```

`~/.harness/workspace.json` (`projects[baplatform].plugins.memory`) says the same. Meanwhile
`docker ps` shows `baplatform-agentmemory  baplatform-agentmemory-agentmemory  127.0.0.1:3211->3111/tcp  Up (healthy)`,
and `harnessConsole.brain.adapterId = deepseek-mcp`.

The gate never asks for `memory` evidence, and `eso-coverage.json` has no `memory` bucket either — so a
consumer at T5 with a live memory service produces the same evidence set as one with none. Any future
`memory` gap or `memoryFetch` path (`eso.memoryFetch: true`) has nothing behind it.

**Direction (consumer, operator):** point `memory` at the running instance (`agentmemory-mcp`, `:3211`)
or record in `decision-policy.json` why it is deliberately `noop`. **Direction (pack):** the maturity
standard's T-tier does not look at adapter wiring; a `T2.x` row that fails when `memory.adapterId` is
`noop` but a memory service answers on the consumer's configured port would have caught this.

### F-04 — observe plane answers the UI but not `/health` (LOW, pack)

`/healthz` → `200 text/html` (the Observatory static app), `/health` → connection failure (`000`).
`compose.harness.yml` maps `8793:8790` for this consumer; the image's healthcheck reports `healthy`, so the
container is fine — the **documented probe is wrong**, and `NO PROBE` was escalated to `SIDECAR_DOWN` by me
(A-2) before I checked `/healthz`. **NOT VERIFIED:** whether `/api/health` or `/status` (the paths the
`atrievefin` log used) are served by *this* image revision `e20d647be778`; I did not probe them.

**Direction (pack):** document one health path that the image actually serves, and have `deploy.sh` verify
it (the consumer log for `atrievefin` used `/health` successfully on `:8795` — so this may be a regression
in the image built for `baplatform`).

### F-05 — `.agents` (Antigravity) runs a stale pack and is idle (MED, consumer)

| Tree | Pack `builtAt` | `harness-hook.mjs` | Trace last row |
|---|---|---|---|
| `.cursor` | `2026-10-22T15:43:07Z` | `791ec8cc…` | `2026-10-23T03:34Z` (this session) |
| `.agents` | same `.harness/host-pack` dir | same file | `2026-10-19T09:55Z`, `route-trace.jsonl` **19.7 MB** |

The pack is shared through `.harness/host-pack`, and upstream dist has already moved on
(`buildAt 2026-10-23T03:09:59Z`, `32435c89…`, +651 B). So *both* trees are one build behind, and `.agents`
has not fired a hook in four days while its trace file keeps growing (no rotation).

**Direction (consumer/operator):** either refresh the pack (`deploy.sh`/host-pack rebuild) so both trees
run `32435c89…`, or stop advertising `agents-superset` in `host-bootstrap.json` and
`~/.harness/workspace.json`. Add trace rotation — 19.7 MB of idle trace is ingest cost no one reads.

### F-06 — the two `guard-shell.py` are not the same file (LOW→MED, consumer hygiene)

```
.cursor/hooks/guard-shell.py   14,279 B   Oct 22 16:51
.agents/hooks/guard-shell.py   14,206 B   Oct 16 21:37
diff → .cursor adds 3 × `sys.stdout.flush()` (lines 224, 231, 239)
```

`guard-write.py` is **byte-identical** on both trees (`26323 B`, same mtime) — so the *deny* behaviour is
symmetric. The shell guard is not: the `.cursor` copy flushes stdout before exiting on deny, the `.agents`
copy does not. On a host that buffers the hook's stdout (Antigravity's `PreToolUse` pipeline), a deny
message can be lost while the process still exits non-zero — i.e. **a silent deny**, the worst of both
outcomes for diagnosis. `x79` reports both guards byte-identical (`34bfe5a3…`); `baplatform` does not, and
nothing in the maturity standard compares the two guard files by hash.

**Direction (pack):** add a hash-equality row per guard file pair to the T0 checks (T0.4 checks
*presence* only). **Direction (consumer):** regenerate `.agents/hooks/*` from the same source that produced
`.cursor/hooks/*`.

### F-07 — gated paths have no consent record, and the gate has already denied (MED, consumer policy)

`~/.harness/consent/` contains **`x79.json` only** — no `baplatform.json`. Yet
`decision-policy.json.paths.gated` lists `.cursor/rules/`, `.agents/rules/`, `.cursor/skills/`,
`.cursor/agents/`, all three `guard-*.py`, `scripts/ci/`, `installation/docgraph/`, `AGENTS.md`, …

The deny log proves it is live, not theoretical:

```
2026-10-22T10:09:20.139Z  tool-deny  edit  projectId=baplatform
  .cursor/rules/delivery.jira-agent-execution.mdc
  harness-eso: … is gated and has no live approval for project "baplatform";
  ask the operator to record consent, or set askMode=host
```

With `eso.mode: hint` this blocks **rule maintenance** (an agent cannot fix a rule it is told to obey),
while `guard-brain`'s `fail_closed` applies to the *evidence* side. `askMode` is unset in
`decision-policy.json`.

Additionally, upstream `eso-blockers.jsonl` is **unattributable for this consumer**: 126 rows carry
`projectId: "opt"`, 45 carry `null`, and exactly **1** carries `"baplatform"`. Whatever produces that
file does not know which project it is logging for.

**Direction (consumer, operator):** either record consent for the specific gated files this repo's
workflow needs to edit, or set `askMode: "host"` so the IDE asks. **Direction (pack):** `projectId` is
not populated on the deny-log path (`-32001`-class observability defect, not a gate defect).

---

## 4. Consistency matrix — what agreed and what did not

| Surface | Value A | Value B | Agree |
|---|---|---|---|
| Port | `harness.config.json server.port 8793` | `registry.json` / `workspace.json` / compose `8793` | ✅ (4 sources) |
| Observe health | `/health` `000` | `/healthz` `200` | ❌ F-04 |
| `eso.mode` | policy `hint` | preflight `mode: hint` + verdict `esoMode: hint` | ✅ (compare `x79`, where stamp said `observe`) |
| `enforceWrites` | policy `fail_closed` | preflight `fail_closed` · stamp `fail_closed` · attest `fail_closed` | ✅ |
| `allowWrite` | stamp `true` @`03:30:56Z` | attest `true` @`03:30:47Z` | ✅ (order is attest→stamp) |
| `brain` | policy `deepseek-mcp` | `mcp.json` has `deepseek-direct` in both trees | ✅ |
| `memory` | integrations `noop-memory` | container `baplatform-agentmemory` `:3211` healthy | ❌ F-03 |
| `guard-write.py` | `.cursor` `26323 B` | `.agents` `26323 B` | ✅ identical |
| `guard-shell.py` | `.cursor` `14279 B` | `.agents` `14206 B` | ❌ F-06 |
| Host pack | installed `791ec8cc…` | dist `32435c89…` | ❌ F-05 |
| Project isolation | `registry.json` 8792/8793/8794/8795 | `docker ps` four distinct containers | ✅ no port clobber |
| `.agents` activity | `host-install-state` declares 6 blocks | last trace `2026-10-19` | ❌ F-05 |

---

## 5. Agent self-audit — what I did badly

**A-1 · Called `harnessctl` and concluded "absent".**
`which harnessctl` → not found; I briefly treated that as "the operator surface is missing". The repo
entrypoints are `./deploy.sh`, `./verify-consumer.sh`, `./console.sh`, `./harness` — `harnessctl` is not the
interface on this machine. I did not re-run `verify-consumer.sh` because the instruction was read-only and
that script writes `.harness/diagnostics/*`; consequence: §2.4 is a **snapshot**, not a re-run.

**A-2 · Declared the sidecar DOWN on a 404 and then on an unprobed path.**
`curl /health` → the sandbox returned nothing and my `|| echo SIDECAR_DOWN` fired; I later wrote
"SIDECAR_DOWN" into the session report *before* discovering `/healthz 200`. A single negative probe is not
down; `docker ps` should have been the first check, not the recovery.

**A-3 · Nearly reported a port clobber as a finding.**
`lsof -iTCP:8793` shows `Google`, `com.docker` and a `dockerd` — my first read was "the port is shared with
other projects". `~/.harness/workspace.json` has four projects on four ports, and `project.json` matches
`harness.config.json`. The `lsof` rows are Chrome's *client* sockets into the container. I dropped the
finding; the audit above states it as ✅ instead.

**A-4 · Ran the audit under a codegraph index that cannot see the harness.**
`codegraph_explore` on this workspace answered from `backend/` and `apps/web/` and reported the harness
symbols as not indexed;
the consumer's own `codegraph.db` excludes `.harness/` and `tools/monitors/harness/`. So every claim about
the pack's behaviour had to come from `rg`/`sed` on `.harness/host-pack/harness-hook.mjs` inside this
consumer, which is a **bundled 118 KB artifact with no source map** — the bundle is produced by
`scripts/build-host-pack.mjs` from the `packages/harness-host-generic/src/dispatcher.mjs` graph
(including `eso-gap-io.mjs`). I compared it to upstream `src/` by marker strings, not by hash lineage:
the installed pack contains `foldStem` / `pathStems` / `isProjectSourcePath` (10 marker hits), so the
mechanisms F-01 quotes are the ones in the bundle. **NOT VERIFIED by line number:** the in-bundle line
numbers may differ from `src/`; all line references in this report are to `src/eso-gap-io.mjs`.

---

## 6. Reproduction

```bash
cd ~/Workspaces/baplatform

# 1. preflight → closure → stamp → attest
cat .cursor/session/.eso-preflight.json        # insufficient / 0.00 / gaps [law:pipeline-gate, code:…]
cat .cursor/session/.eso-gap-closure.json      # allClosed true; last tool_uses Shell has no path
cat .cursor/session/.eso-bundle-stamp.json     # sufficient / 1.0 / allowWrite true
cat ~/.harness/attest/baplatform.json          # same, ttl 600

# 2. F-01: the law gap closes on a term inside a shell argument, not on the rule
rg -n "stemHaystack|closesGap|isProjectSourcePath" \
   ~/Workspaces/harness-eso/packages/harness-host-generic/src/eso-gap-io.mjs

# 3. F-02: the law index is older than the law
python3 -c "import json;print(json.load(open('.docgraph/docgraph.json'))['generated_at'])"   # 2026-10-19T16:52:…
find sdlc .cursor/rules -newer .docgraph/docgraph.json \( -name '*.md' -o -name '*.mdc' \) | wc -l   # 27
docgraph --q "pipeline-gate preflight ESO write gate" --top 3 --repo .                    # no core.pipeline-gate.mdc

# 4. F-03 / F-06 / F-07
cat .harness/integrations.json | python3 -c "import json,sys;print(json.load(sys.stdin)['memory'])"
docker ps --format '{{.Names}}\t{{.Status}}' | grep baplatform-agentmemory
diff .agents/hooks/guard-shell.py .cursor/hooks/guard-shell.py
ls ~/.harness/consent/                     # x79.json only

# 5. F-05: installed pack vs upstream dist
shasum -a 256 .harness/host-pack/harness-hook.mjs \
              ~/Workspaces/harness-eso/packages/harness-host-generic/dist/host-pack/harness-hook.mjs
tail -1 .agents/session/route-trace.jsonl | cut -c1-120      # 2026-10-19T09:55Z
```

---

## 7. Upstream tickets this suggests

| # | Title | Sev | Files |
|---|---|---|---|
| U-1 | law-gap closure must not accept the whole tool-argument haystack | MED | `packages/harness-host-generic/src/eso-gap-io.mjs:239-302` |
| U-2 | harness state (`.harness/**`) must not be law evidence | MED | same, `isNonSourcePath` reuse for law kind |
| U-3 | T0 check: guard files in `.cursor` and `.agents` must be hash-equal | MED | `consumers/*-maturity*`, `scripts/*-consumer*` |
| U-4 | maturity should fail when `memory.adapterId=noop` but a memory port answers | LOW | maturity standard |
| U-5 | document and verify the one health path the observe image serves | LOW | `compose.harness.yml`, `deploy.sh`, `documents/` |
| U-6 | deny-log must record `projectId` | LOW | observe/ingest (`eso-blockers.jsonl`) |

Fix order: **U-1 + U-2** together (they are the same gate), then **U-3** (cheap, catches F-05/F-06), then
the rest. Consumer-side F-02 (rebuild docgraph), F-03 (memory adapter), F-05 (pack refresh vs drop
`agents-superset`), F-07 (consent or `askMode`) are operator decisions and should **not** be patched into
`baplatform` before the pack behaviour is fixed — otherwise the consumer bakes in a workaround the next
pack build will undo.

---

## 8. Evidence index

| File | What it is |
|---|---|
| [`agent-session-2026-10-23T0328Z/turn.jsonl`](./agent-session-2026-10-23T0328Z/turn.jsonl) | 31 raw `route-trace.jsonl` rows for generation `a316c2da…`; `user_email` redacted |
| [`…/eso-preflight.json`](./agent-session-2026-10-23T0328Z/eso-preflight.json) | `.cursor/session/.eso-preflight.json`, `03:28:38Z` |
| [`…/eso-gap-closure.json`](./agent-session-2026-10-23T0328Z/eso-gap-closure.json) | Closure, `allClosed: true` @`03:30:56Z`, 22 tool uses |
| [`…/eso-bundle-stamp.json`](./agent-session-2026-10-23T0328Z/eso-bundle-stamp.json) | Verdict mirror `sufficient / 1.0 / allowWrite true` |
| [`…/pipeline-brain-stamp.json`](./agent-session-2026-10-23T0328Z/pipeline-brain-stamp.json) | `via: ask_deepseek_flash_brain`, class `delivery-intake` (previous session; not refreshed this turn) |
| [`…/decision-policy.json`](./agent-session-2026-10-23T0328Z/decision-policy.json) | Consumer policy: `eso.*`, `skillPacks`, `paths`, `tokenDiet` |
| [`…/integrations.json`](./agent-session-2026-10-23T0328Z/integrations.json) | `memory: noop-memory` (F-03) |
| [`…/host-bootstrap.json`](./agent-session-2026-10-23T0328Z/host-bootstrap.json) | `cursor-superset` + `agents-superset`, `appliedAt 16:03:23Z` |
| [`…/host-pack.json`](./agent-session-2026-10-23T0328Z/host-pack.json) | Installed manifest `791ec8cc…` / `builtAt 15:43:07Z` (F-05) |
| [`…/consumer-maturity-latest.md`](./agent-session-2026-10-23T0328Z/consumer-maturity-latest.md) | T5 snapshot `2026-10-22T12:49Z` — **not** a fresh run (A-1) |
| [`…/cursor-hooks.json`](./agent-session-2026-10-23T0328Z/cursor-hooks.json) · [`…/agents-hooks.json`](./agent-session-2026-10-23T0328Z/agents-hooks.json) | Declared hook surface per tree |
