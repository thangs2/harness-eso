# Analysis — 2026-10-22 · who owns which finding (source-attribution matrix)

> **Status:** derived analysis, not evidence. Every row cites a line of code or a line of an artifact in
> this folder; none cites another artifact's *conclusion*. Where an artifact's conclusion and the code
> disagree, the code wins and the row says so.
>
> **Inputs:** the four session logs in this folder (`x79`, `baplatform`, `fineso` + addendum,
> `atrievefin`) — 30 runtime findings and 24 agent self-audit defects between them.
>
> **What this is for:** a reviewer asking "is this a consumer problem or a `harness-eso` problem?" without
> re-reading 900 lines of session log. It is **not** law, a fix plan, or a substitute for
> [`../../documents/03.state-and-contracts/06.evidence-sufficiency-defects.md`](../../documents/03.state-and-contracts/06.evidence-sufficiency-defects.md),
> which holds the authoritative H1–H7 analysis of the same mechanism.

| Field | Value |
|---|---|
| Written | 2026-10-22, `harness-eso` workspace |
| Scope | findings raised by consumer sessions against the ESO runtime |
| Method | one Read of each artifact, then direct code reads; no test run, no consumer run |
| Not done | no `bun test`, no reproduction on any consumer, no fix |

---

## 0. Read this first

Three conclusions the matrix is built on, each of which changes how a finding should be owned:

1. **The artifact's own verdict is not evidence.** `README.md:9-11` says so. Several findings below are
   marked *does not reproduce* for exactly this reason.
2. **The loudest finding is misdiagnosed.** "The gap tracker evaluates only preflight → first tool
   round" appears in **three of four** logs. It is false: `gap-tracker-hook.mjs:53` calls
   `recordGapToolUse()` on **every** `postToolUse`. The gap does not close because of **P1**, not because
   of a window. A fix aimed at re-evaluation would change nothing.
3. **A green maturity score does not mean the consumer is clean.** Both T5 consumers are red on
   `token-diet` while `verify-consumer.sh` reports `pass=25 fail=0`.

---

## 1. Defects of `harness-eso` — product must fix

| ID | Finding (raised in) | Code | Sev | Why it is ours |
|---|---|---|---|---|
| **P1** | A `law` gap naming `pipeline-gate` cannot be closed by reading `core.pipeline-gate.mdc` — bp **D1**, reproduced as x79 **F-C**, at **F-3**, fin **F-3** | `eso-gap-io.mjs:128-131` — `hay.includes('pipeline-gate')` against the string `.cursor/rules/core.pipeline-gate.mdc` is **false**; the `.` after `core` breaks the run | **HIGH** — blocks every `enforceWrites: fail_closed` consumer | Every consumer rule is named `core.*` / `stack.*` / `delivery.*`, so **no consumer can close a law gap by reading law**. The only closures ever observed were accidental (a `Grep` pattern, or a path in a *different* repo) |
| **P2** | Post-closure `score` is `Math.max(pre.score, 0.85)` — fin **F-4**, bp **D6** | `eso-gap-io.mjs:187` | HIGH | `0.1833 → 0.85` because a JSON blob contained a substring. `level` flips to `sufficient` and `allowWrite` to `true` in the same branch. An `85` produced this way is indistinguishable from a measured one |
| **P3** | Stamp + attestation are written only when **every** gap closes — bp **D6** | `eso-gap-io.mjs:180` (`if (doc.allClosed && pre)`) | MED | Partial progress writes `.eso-gap-closure.json` and nothing else, so `guard-write.py` (which prefers the attestation) sees a frozen verdict while the closure file says `1 of 2` |
| **P4** | Preflight never fetches law, so a law gap is emitted every turn — bp **D2** | `packages/harness-eso-core/src/collect.mjs` `detectGaps()` — `lawText` is built from `retrieval.snippets`, which only `runCollect()` populates; JEV is `off` | HIGH (root of P1's inevitability) | Holds for every consumer with a `tools` or `backend` bucket, on all four |
| **P5** | The `code` gap closes on any path at all — bp **D5** | `eso-gap-io.mjs:119-120` — `if (extractFilePath(toolInput)) return true`, no root check, no bucket check | MED | Reading `.cursor/skills/eso-recon/SKILL.md`, or a file in another repo, closes a gap whose stated purpose is "the project's code was inspected" |
| **P6** | The Brain gate denies the only mechanism that could clear it — bp **D4** | `guard-brain-hook.mjs:61-71` → `shouldBlockBrain()` (`eso-gap-io.mjs:207-220`) — denies whenever `closure.allClosed !== true` | HIGH (deadlock amplifier) | A Brain call is an evidence source, not a write. On `baplatform` this removed the last legal recovery path |
| **P7** | `*mcp.json` is not deny-read, so the natural first probe lifts a live token — fin **A-1**, at **A-1/A-2**, x79 **A-1** (each agent filed it against *itself*) | `privacy.denyPathPatterns` covers `.env`, `credentials`, `session/*.json`, `typesafe.env`; `*mcp.json` is gated for **writes** only | MED | The agent behaviour is reasonable; the product told it nothing. This is H7 and it is ours, not the consumer's |
| **P8** | `verify-consumer.sh` is blind to P1–P5, `token-diet`, and path-policy drift — fin **F-x**, bp §3 | `verify-consumer-cmd.mjs:143-158` (`file_contains_any` checks a **line of text**, never the filesystem object it names) | HIGH (trust, not runtime) | A green 25/0 next to a red linter is a check measuring the wrong thing. See **N5** below for the wrapper half |
| **P9** | `verify-consumer.sh <abs path>` → `Unknown consumer` while `harnessctl verify consumer <path>` accepts it — fin **F-12**, x79 **A-6**, at **A-6** | `verify-consumer.sh:100-112` resolves a **registry id** only; `verify-consumer-cmd.mjs:22-24` resolves a **path** first | LOW (usability) | Two surfaces, two contracts for one command. Cost 1–2 calls in three sessions |
| **P10** | The `code` gap text reads as an accusation — fin **F-5**, at **F-4** | gap string is `need at least 1 file read(s); have 0`, emitted at `beforeSubmitPrompt`, i.e. **before** the first tool call | LOW (wording) | It means "at turn start". Suggested: `have 0 (turn start)` |

**Fix order** (from `06.evidence-sufficiency-defects.md` §5, unchanged here): **P1 → P4 → P2+P3 → P5 → P8
→ P7**, with **P6** landing alongside P1/P4 — otherwise the next turn reproduces the deadlock through a
different door.

---

## 2. Defects of the consumer — not ours to patch

| ID | Finding (raised in) | Consumer | Why it belongs to the consumer |
|---|---|---|---|
| **C1** | Seven `.mdc` files inside `.agents/rules/` beside their `.md` twins; **6 of 7 twins describe different rules** — fin **F-11** | fineso | `.mdc` is Cursor's format, copied into the Antigravity tree. `scripts/ci/verify-dual-harness.mjs` exiting 1 is **correct**. Only `core.scope-fallback` is byte-identical |
| **C2** | One rule declares `alwaysApply: true` **and** `globs` — fin addendum §1 | fineso (`fineso.engineering-slp`, both trees), baplatform (`delivery.jira-agent-execution`) | `token-diet` `frontmatterIntegrity` is right to fail; the file contradicts the harness's own prescribed design (`WORKFLOW_GUIDE.md` §3). The owner must choose: drop `globs` or drop `alwaysApply` |
| **C3** | Plaintext Atlassian token in `.cursor/mcp.json` **and** `.mcp.json`, tracked by git, with `NODE_TLS_REJECT_UNAUTHORIZED: "0"` — fin §3.1, at §2.1 | fineso, atrievefin | Secret in the consumer repo. (The *read* of it is **P7**, ours; the *presence* is theirs) |
| **C4** | `docgraph.scope` lists `path:SDLC/00.agent-manifests`, which does not exist — at **F-6** | atrievefin | The consumer wrote a scope line for a zone it never created. The harness's failure to notice is **P8** |
| **C5** | `integrations.json` says `adapterId: noop-memory` while `harness.config.json` says `agentmemory-mcp`; measured recall **0.016** — fin **F-9**, at §6.5 | fineso, atrievefin | Stale adapter record. `core.conversation-hygiene` *commands* `memory_smart_search` every turn and the harness does not enforce it — so the rule reads as theatre on these consumers |
| **C6** | `decision-policy.paths` **replaces** the pack default rather than merging, so emptying the list un-gates `AGENTS.md`, `.cursor/rules/`, `.agents/rules/` and `guard-write.py` itself — fin **F-7** | fineso | The replacement rule is documented in a code comment (`guard-write.py:141-177`), not in the consumer's policy or guide. `fineso`'s list (22) and the default (23) already disagree (**F-8**) |
| **C7** | The consumer's own rule says `preflight.enabled: false` while its policy says `true` — x79 **F-D** | x79 | Doc drift inside the consumer repo; actual behaviour followed the policy |
| **C8** | `.agents/session/` holds the three `.eso-*.json` files but no `route-trace.jsonl`, although `harness.config.json` declares full parity — fin **F-13**, at **F-5** | fineso, atrievefin | Provisioned ≠ exercised. Consequence: `verify-dual-harness` has never seen real Antigravity traffic on either consumer |
| **C9** | `harness.config.json` declares `storage.sqlite.path: ".harness/harness.db"`; nothing exists there — fin **F-1**, at **F-1**, all four | all four | **Split ownership.** The declaration is the consumer's; that the tooling ignores it and the docs never say so is ours (**N1**) |

---

## 3. Not defects — by design, or does not reproduce

Do **not** patch these. Recorded because an agent acting on them writes a patch for a non-bug.

| ID | Finding | Verdict |
|---|---|---|
| **N1** | Sidecar writes `/data/observe/<id>/harness.db` while the consumer declares `.harness/harness.db` | **Wiring is correct** — the hook path reads the consumer config, the container mounts its own DB. The *consequence* (deleting the container drops the whole observe history) is undocumented. Half C9, half a doc gap |
| **N2** | `mode: "hint"` and `enforceWrites: "fail_closed"` on the same stamp — fin **F-2**, at **F-2** | **Correct, and it worked**: `atrievefin` ran 0 Writes with `allowWrite: false` throughout. The defect is the *reading* — "hint" sounds like "no enforcement" — so the Console should render the pair explicitly |
| **N3** | `/api/requests` had no row for the live turn while SSE `live` already carried it — x79 **F-A** | **By design**: `/api/requests` is fed by the host transcript spine (flushed later), `/events` is the live path. Needs a doc line and a `pending` badge |
| **N4** | `/api/gate/events` → `{ "items": [], "total": 0 }` — x79 **F-B** | **Correct for this consumer** (`enforceWrites: off`): the trail records **blocked** writes only. The Gate page should say so |
| **N5** | "The gap tracker evaluates only preflight → first tool round" — fin **F-3**, at **F-3**, x79 **F-C** | **False.** `gap-tracker-hook.mjs:53` runs `recordGapToolUse()` on every `postToolUse`. The gap does not match — **P1**. A "re-evaluate later rounds" fix would change nothing |
| **N6** | "Guard commands are emitted as bare `python` → exit 127 on every shell" — bp **D3** | **Does not reproduce from this tree.** `profiles/host/cursor-superset.json:23-81` emits `node .harness/host-pack/harness-hook.mjs --hook X --tree Y`, no `python`; `route-hook.mjs:36-39` probes `python3`/`python`/`py`. The *symptom* may be real — the report itself saw the hook fire after `.cursor/hooks.json` was deleted, so the effective entry is a stale host-settings one. **Unproven, not disproven** |
| **N7** | bp **D2** cites `harness/evidence-sufficiency-orchestrator/src/eso-preflight.mjs` | **The module no longer exists** — the path is from the archived design. The behaviour is real and is **P4**; the citation is from memory |
| **N8** | "No `stop` row for this generation" — fin §5, OPEN-1 | **Resolved** in the addendum §2: the row landed at `13:38:54Z`. Cursor does send `hook_event_name`; only the *mid-turn absence* was ever observed. The real gap is that a missing `stop` is **silent** (route fails open, no counter on `/health`) |
| **N9** | `T0.4 "Write guards present (both trees)"` passes on file **existence** while the two trees gate writes by different mechanisms — fin **F-10** | **Check is weaker than it reads** (`profiles/standards/consumer-maturity.v1.json:81-88`, type `all_exist`). True as stated; the fix is **P8**, not a consumer change |
| **N10** | `T3.4` passes on the *scope line* while the zone directory does not exist — at **F-6** | Same shape: `file_contains_any` reads text (`verify-consumer-cmd.mjs:143-158`). Part of **P8** |
| **N11** | `harness.config.json` ingest declares `.agents` at full parity while no trace exists | Correct — see **C8**. Not a runtime defect |
| **N12** | `codegraph_explore` (MCP) cannot close the `code` gap on `fineso` while a plain `Read` can — fin **F-6** | **Narrower than reported.** `eso-gap-io.mjs:121-125` *does* accept a codegraph call when the gap is the read-count gap and a `query` is present; but the row arrives as `MCP:codegraph_explore`, which `READ_TOOL_RE` (`:5`) does not match, so the `code` **kind** is only added by `CODEGRAPH_RE` on the blob — and then `extractFilePath` finds a `projectPath` and closes it. Two code-recon acts are still treated unequally; fold into **P5** |
| **N13** | `.agents/` configured but idle, `T0.3`/`T0.4` still green | Correct — **C8** |

---

## 4. Defects of the agent — neither product nor consumer

Aggregated across the four logs. These are the behaviours that produced bad reports, and the reason some
of the rows above had to be disproven.

| Pattern | Raised in | What the product could do |
|---|---|---|
| Read a secret-bearing file as an early probe (`key.md`, `*mcp.json`) | x79 **A-1**; fin **A-1**; at **A-1/A-2** | **P7** — the only one of these with a product fix |
| `docker ps` from a sandbox with no docker socket | x79 **A-2**; at **A-3** | Nothing; recon discipline |
| Wrong `verify-consumer.sh` invocation, twice or more | x79 **A-6**; fin **A-3**; at **A-6** | **P9** — accept a path |
| Measured eager rules with `rg` instead of the canonical `token-diet`, then reported PASS that was **wrong** | fin **A-8** | Nothing — but this is the single most dangerous pattern here: a hand-rolled proxy answers a different question and reads as an endorsement |
| Probed a guard with an **attack-shaped** command (`rm -rf .cursor/rules` from `/tmp`) — correctly blocked | fin **A-4** | Nothing; the guard was right |
| Wrote the artifact while knowing the stamp authorising it was weak (P1/P2) | fin **A-7** | Nothing — but it is why this file separates *evidence* from *conclusion* so sharply |
| Quoted a stale `diagnostics/latest.md` as the verdict instead of re-running | at **A-6**; x79 **A-5** | Nothing; treat the file as a snapshot and re-run |
| `memory_save` without `content`; `docgraph --version` | x79 **A-3**; fin **A-6** | Nothing |

---

## 5. Coverage matrix — which defect touched which consumer

| Defect | x79 | baplatform | fineso | atrievefin |
|---|:--:|:--:|:--:|:--:|
| **P1** law gap unclosable | ✔ | ✔ | ✔ | ✔ |
| **P2** invented score | · | ✔ | ✔ | · |
| **P3** frozen stamp | · | ✔ | · | · |
| **P4** preflight never fetches law | ✔ | ✔ | ✔ | ✔ |
| **P5** `code` gap closes on any path | · | ✔ | · | · |
| **P6** Brain gate blocks its own evidence | · | ✔ | · | · |
| **P7** `*mcp.json` not deny-read | ✔ | · | ✔ | ✔ |
| **P8** maturity blind to the above | ✔ | ✔ | ✔ | ✔ |
| **P9** path vs id | ✔ | · | ✔ | ✔ |
| **C1** `.mdc` in `.agents/rules` | · | · | ✔ | · |
| **C2** `alwaysApply` + `globs` | · | ✔ | ✔ | · |
| **C3** token in plaintext | · | · | ✔ | ✔ |
| **C5** `noop-memory` | · | · | ✔ | ✔ |
| **C6** paths replace, not merge | · | · | ✔ | · |
| **C8** `.agents` never exercised | · | · | ✔ | ✔ |
| Agent opened a secret file | ✔ | · | ✔ | ✔ |

**Severity by consumer**

- **`baplatform` — the deadlock, real.** `fail_closed` + P1 + P4 + P6 at once, plus a P3 stamp that never
  moved. The one consumer where the turn could not recover by any legal action. P1 and P6 were confirmed
  in `06.evidence-sufficiency-defects.md` §2; P3 there is H3.
- **`fineso` — T5 and still red.** `pass=25 fail=0` while `token-diet` fails on both trees (**C2**) and
  `verify-dual-harness` exits 1 (**C1**). This is the clearest demonstration of **P8**: the standard
  cannot see either.
- **`atrievefin` — T2, clean runtime.** Everything failing is T3+ authoring the consumer has not done.
  Its value to this matrix is C4 + the second measurement of C3/C5.
- **`x79` — T2, dev consumer, `enforceWrites: off`.** So P1/P4 are **latent** here: they are real, but the
  write gate never engaged. Reading `x79` alone would under-rate them.

---

## 6. One line per owner

| Owner | State |
|---|---|
| **`harness-eso`** | Ten product findings (**P1–P10**). P1 and P4 form a closed loop that no consumer can escape while `fail_closed` is on; P2/P3 make the verdict state lie; P6 removes the escape hatch; P8 is why a red consumer reports green. **P7** is the only product fix for an agent-side behaviour |
| **Consumer** | Nine findings (**C1–C9**), none of them patchable here — but `verify-consumer.sh` must be able to *see* C1, C2, C4 and C6 (**P8**), otherwise "green means green" is broken. **C9** is co-owned: the declaration is theirs, the silence is ours |
| **Agent** | Same three patterns in 3/4 sessions: opened a secret file, used a hand-rolled proxy where a canonical checker existed, wrote before verifying. Only the first has a product fix |

---

## 7. What this matrix does not claim

- It is a **map of ownership**, not a verification. Every code citation was read directly, but no test was
  run and no finding was reproduced on a consumer in this session.
- A row marked **P*** is owned by `harness-eso` **because the code shows it**, not because an artifact said
  so. Where the artifact's own diagnosis was wrong (**N5**, **N6**, **N7**), the wrong diagnosis is
  recorded rather than silently corrected — the correction is the evidence that the artifact was not
  read as law.
- Counts here are per *finding*, not per *symptom*: one root cause (P1) produced four separate findings
  in four logs.

---

## 8. Reproduce the code reading

```bash
# P1 / P2 / P3 / P5 — the whole write gate hangs on this file
sed -n '111,196p' ../../packages/harness-host-generic/src/eso-gap-io.mjs
# P4
sed -n '1,40p'   ../../packages/harness-eso-core/src/collect.mjs
# P6
sed -n '55,80p'  ../../packages/harness-host-generic/src/guard-brain-hook.mjs
# N5 — the claim that the tracker only runs one round
sed -n '45,60p'  ../../packages/harness-host-generic/src/gap-tracker-hook.mjs
# P8 / N9 / N10 — why T3.4 passes on text
sed -n '143,160p' ../../packages/harness-cli/src/verify-consumer-cmd.mjs
# N6 — no bare `python` in the emitters
grep -n '"command"' ../../profiles/host/cursor-superset.json
# P9 — two contracts for one command
sed -n '100,112p' ../../verify-consumer.sh
sed -n '22,31p'   ../../packages/harness-cli/src/verify-consumer-cmd.mjs
```
