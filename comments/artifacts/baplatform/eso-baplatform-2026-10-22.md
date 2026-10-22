# Consumer report — `baplatform` ESO fail-closed deadlock (2026-10-22)

Read-only report produced by a consumer session. No consumer-side patch was applied; every finding below
needs an upstream fix in `harness-eso`, then a `host-pack refresh` on the consumer.

- **Consumer:** `/Users/thangs2net/Workspaces/baplatform` (dual-IDE: `.cursor` + `.agents`)
- **Host pack:** v0.1.0, `builtAt 2026-10-22T12:41:13.567Z`, bootstrap `appliedAt 12:49:35.738Z`
- **Maturity diagnostic:** T5, pass 25 / fail 0 / critical 0 (`diagnostics/2026-10-22T12-49-41-724Z.json`)
- **Preflight:** generation `b8a5b04d-621c-45ee-ba61-a6c38a7ae492`, `2026-10-22T12:52:33Z`, bucket `tools`

---

## 0. Symptom in one paragraph

First prompt of a fresh conversation (`baplatform test eso`) produces `level: insufficient`, `score: 0`
with two gaps (`law:pipeline-gate`, `code:need at least 1 file read(s); have 0`). No `Read`/`Grep`/memory
call on the consumer repo closes the `law` gap, so `.eso-gap-closure.json` stays `allClosed: false`. With
`eso.mode: hint` + `eso.enforceWrites: fail_closed` the consumer is then `DENY_ESO` for every gated path,
**and** `guard-brain` blocks the `ask_deepseek_*` calls that would let the agent re-attest. The turn cannot
recover by any legal action.

The gap finally closed at `12:58:21Z` only because the agent read a **different repo**
(`/Users/thangs2net/Workspaces/harness-eso`), whose path carries the literal `pipeline-gate`. That single
observation is D1 and D5 at once: the gate closed on an accidental path, not on the artifact the law query
names.

---

## 1. Defects

### D1 — law gaps are not closable by any path-based recon (HIGH, deadlock)

`packages/harness-host-generic/src/eso-gap-io.mjs` → `closesGap()`:

```js
const target = String(gap?.query || gap?.path || '').toLowerCase();
if (!target || target === '?') return true;
const hay = JSON.stringify(toolInput || {}).toLowerCase();
return hay.includes(target) || target.split('/').some((seg) => seg.length > 3 && hay.includes(seg));
```

`gap.query` is the literal string from `decision-policy.eso.skillPacks.<bucket>.lawQueries` — here
`['pipeline-gate']` for bucket `tools`. The consumer artifact is `.cursor/rules/core.pipeline-gate.mdc`,
so a `Read` sends `{"path": ".../core.pipeline-gate.mdc"}`. The basename is `core.pipeline-gate.mdc`;
`"pipeline-gate"` is **not** a substring of it (a `.` separates `core`), and no `/`-segment contains it.
Same shape for `core.ap-platform` → `core.ap-platform.mdc` in the `backend` pack, and for any consumer rule
named `core.*` / `stack.*` / `delivery.*`.

**Direction:** match on the *normalised stem* — fold `.`/`-`/`_` to one separator on both sides (or compare
`target` against each dot-separated token of the basename), case-insensitive. A term should close a law gap
when it appears as a path *stem* token, not only as a raw substring. Keep the strict literal path where
exactness matters.

**Do not** relax to plain segment matching — the caveat in
`documents/08.archive/frontier/03.issue-gap-code-read-count-unclosable.md` still holds. Do not change the
consumer's `lawQueries`; the consumer's term is correct.

### D2 — `lawQueries` are never pre-fetched, so `requiredDocTerms` can only be satisfied by luck (HIGH, same root)

`packages/harness-eso-core/src/collect.mjs` → `runCollect()` fetches `pack.lawQueries` through the law
adapter, but the preflight path
(`harness/evidence-sufficiency-orchestrator/src/eso-preflight.mjs`) calls `buildEvidencePlan` +
`runRetrieval` and only invokes docgraph inside the optional JEV escalation (`jevOnPartial`, and
`jev.mode` is `off` here). Net: `detectGaps` compares `requiredDocTerms` against `lawText` that was never
fetched during preflight → a law gap is emitted every turn on every `tools`/`backend` consumer, and only a
tool argument containing the term can clear it.

**Direction:** run the law adapter for `lawQueries` once inside preflight (cache under
`.harness/cache/docgraph/`, TTL already 1h) before `detectGaps`, or make the JEV ladder default-on for
`law` gaps.

### D3 — guard commands are emitted as bare `python` (HIGH, availability, macOS)

Consumer hook config:

```json
"command": "python .cursor/hooks/guard-write.py"
"command": "python .cursor/hooks/guard-shell.py"
```

On macOS 25.6 there is no `python`, only `python3`:

```
Command execution was blocked by a hook: Hook "python .cursor/hooks/guard-shell.py" failed with exit code 127:
zsh:1: command not found: python
```

Result: **every** Shell execution is denied fail-closed, and `guard-write` itself exits 127, so **every**
Write is denied too — in any repo, not just the consumer. The consumer cannot run `rg`, `git status`, or
`codegraph`; nothing can be written anywhere on the machine through the agent. Pack-internal inconsistency:

- `packages/harness-host-generic/src/harness-hook.mjs` → `resolveRouteHookPy()` spawns `python3` only;
- the same consumer's `.agents/hooks.json` tracer runs `python3 .agents/hooks/pre-tool-use.py`, while the
  Cursor guards beside it run `python`.

The literal string is generated (it is not in `profiles/host/*.json`), which is why it drifted. It also
survives with the repo-level `.cursor/hooks.json` deleted — observed 2026-10-22 20:06 local: the file was
`File not found` while the hook still fired, so the effective config lives in Cursor settings merged from
`.harness/host-install-state.json`, not in the repo.

**Direction:** emit `python3` from the guard-preset source (`host-install.mjs` / `ensureConsumerGuards`
area, or the profile presets), or emit a resolved interpreter path. Both trees, all guard entries, and make
`host-install-state` point at a file that actually exists.

### D4 — the Brain gate blocks the only mechanism that could clear it (HIGH, deadlock amplifier)

`guard-brain-hook` (`shouldBlockBrain`) denies `ask_deepseek_*` whenever the closure is incomplete. But a
Brain call is an *evidence source*, not a write. Blocking it removes the agent's ability to refresh an
expired stamp (`guard-write` still accepts the session stamp under fallback, but on this consumer it read
`at: 04:10:00Z`, 8h42m before the turn; TTL 30 min).

**Direction:** never gate Brain tools on the write gate; gate only on locked/secret paths. If attributable
Brain calls are required, have `guard-brain` *annotate* the closure instead of deny.

### D5 — the read-count gap closes on an unqualified path (MEDIUM, false positive)

`Read .cursor/skills/eso-recon/SKILL.md` closed `code:need at least 1 file read(s); have 0`, and later so
did a `Grep` whose `path` was a *different repo*. The gap exists to prove the project's code was inspected;
a skill file proves nothing and the pack's `codeQueries` for `tools` is `['harness']`. Effect: score jumps
0.45 with no project source read.

**Direction:** require the path to match `skillPacks.<bucket>.codeQueries`, or at minimum exclude
`.cursor/`, `.agents/`, `.harness/`, `node_modules/`, and any path outside the preflight `root`.

### D6 — progress never reaches the stamp or the attestation (MEDIUM, misleading telemetry)

`.eso-bundle-stamp.json` was written once at preflight (`level: insufficient`, `score: 0`,
`allowWrite: false`, `preflightAt: 12:52:33Z`) and not updated while the closure moved to 1/2 — because
`recordGapToolUse` only calls `writeBundleStampFromPreflight` on `allClosed`. The product-state attestation
(`~/.harness/attest/<project>.json`) is written only from that same call. Every reader (`guard-write.py`
prefers the attestation) sees a frozen verdict, while the preflight file keeps `mode: hint` next to
`enforceWrites: fail_closed`.

**Direction:** rewrite stamp + attestation on every closure change with `score = closed/required` and a
recomputed `level`; keep `preflightAt` stable. The two files must not disagree about `mode`.

### D7 — nothing in the hint names the closing action (MEDIUM, usability)

The post-tool hint says "insufficient … fetch evidence". On this consumer the closing actions were
non-obvious (a docgraph literal query, or a `grep` whose *path* contains the term — which D3 blocks). Cost
per failed turn: the whole recon budget.

**Direction:** emit the exact closing action per gap, e.g.
`law:pipeline-gate → docgraph --q "pipeline-gate"` and `code:… → read a path under <codeQueries>`.

### D8 — `allow_session_stamp_fallback` still defaults to `true` (LOW)

`guard-write.py` defaults `True`, and `eso_attestation()` silently returns `{}` when product state has no
attestation. A consumer at T3+ should default to `false`, so a missing/expired attestation reads as
`insufficient`, not as "no gate".

### D9 — `STALE` cognitive state with zero pinned invariants (LOW, observation)

`cognitiveState: STALE`, `pinnedInvariants: []`, `domain: default` even though the consumer has
`sdlc/00.governance/00.context-contract.json` (17 domains, invariants) and `.harness/eso-coverage.json`
(T3.3 PASS). Worth checking whether invariant detection runs at hook time or only during provisioning.

---

## 2. Reproduction

```bash
cd ~/Workspaces/baplatform
# eso.enforceWrites = fail_closed  (already the case here)
# send a first prompt in a fresh conversation, e.g. "baplatform test eso"

cat .cursor/session/.eso-preflight.json      # level insufficient / gaps [law, code]
cat .cursor/session/.eso-gap-closure.json    # allClosed false; code gap closed by a skill-file Read
cat .cursor/session/.eso-bundle-stamp.json   # unchanged since preflightAt
# Read .cursor/rules/core.pipeline-gate.mdc, re-check closure -> still open  (D1)
# Run any Shell command -> guard-shell exits 127                             (D3)
```

Suggested regression cases for `eso-gap-io.test.mjs`:

| Tool input | Gap | Expected |
|---|---|---|
| `Read { path: '.cursor/rules/core.pipeline-gate.mdc' }` | `law:pipeline-gate` | closes (D1) |
| `Grep { pattern: 'pipeline-gate' }` | `law:pipeline-gate` | closes |
| `Read { path: 'AGENTS.md' }` | `law:pipeline-gate` | stays open |
| `Read { path: '.cursor/skills/eso-recon/SKILL.md' }` on a `tools` bucket | `code:need at least 1 …` | stays open (D5) |
| `Read { path: 'packages/harness-host-generic/src/eso-gap-io.mjs' }` | `code:need at least 1 …` | closes |

---

## 3. Severity roll-up

| ID | Area | Sev | Blocks consumer? |
|---|---|---|---|
| D1 | gap closure (law) | HIGH | yes |
| D2 | preflight law fetch | HIGH | yes (root of D1's inevitability) |
| D3 | hook command `python` | HIGH | yes (all Shell + all Writes) |
| D4 | guard-brain vs stamp | HIGH | yes |
| D5 | gap closure (code) | MED | no, false positive |
| D6 | stamp/attestation freshness | MED | no, misleading |
| D7 | hint content | MED | no, cost |
| D8 | session-stamp fallback default | LOW | no |
| D9 | invariant pinning | LOW | no |

Fixing D1 + D3 unblocks the consumer. D2/D4 must land with D1, or the next turn reproduces the deadlock
through a different door.

---

## 4. Consumer evidence files (read-only)

```
<consumer>/.cursor/session/.eso-preflight.json
<consumer>/.cursor/session/.eso-gap-closure.json
<consumer>/.cursor/session/.eso-bundle-stamp.json
<consumer>/.cursor/session/.pipeline-brain-stamp.json
<consumer>/.harness/decision-policy.json           (eso.* + skillPacks.tools)
<consumer>/.harness/host-pack/harness-hook.mjs     (bundled eso-gap-io / guard-brain / guard-shell)
<consumer>/.harness/host-install-state.json        (effective hook commands)
<consumer>/.harness/diagnostics/latest.json        (maturity T5)
```

Also persisted in AgentMemory as `mem_mvjjt0tb_c2590a2a73a2` (same content, in case this file is lost).