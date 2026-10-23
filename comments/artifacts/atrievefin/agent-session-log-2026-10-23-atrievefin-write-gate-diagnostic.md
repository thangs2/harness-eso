# atrievefin — why protected writes stay denied (path / evidence / brain)

**Date:** 2026-10-23 (session `8555a188`, generation `8dac9f8e…`, window 10:21Z–11:15Z)
**Consumer:** `atrievefin` (`/Users/thangs2net/Workspaces/atrievefin`)
**Host:** Cursor 3.27.6 · pack `32435c89…` (same pack the 2026-10-23 audit ran on)
**Nature:** properties and observed behaviour only. No remediation proposed — that judgement belongs upstream.
**Written at:** the human owner's explicit instruction to record this against `harness-eso` (see §6 of
the attribution note). The consumer's `AGENTS.md` forbids an agent touching a sibling repo, so this file
exists only by that instruction, not by agent initiative.

---

## 0. How to read this

This is the **cause side** of a session that had to fall back to hand-written commits. The 2026-10-23
audit (`agent-session-log-2026-10-23-atrievefin-audit-diagnostic.md`, F-01…F-12) already established that
the law adapter returns nothing on this consumer. That log answered *what is missing*. This one answers
*what that missing evidence does to a consumer that must publish documents every day*, and which of the
three gates actually stands in the way at write time.

It deliberately stops before "so the right design is …". Four sections: the path tier, the evidence
gate, the brain gate, and the specific collision between "SDLC is a knowledge base" and the tier model.

---

## 1. The path layer — a configuration decision, not a classifier

The write guard asks one question first: which tier does the target path have.

`WORKFLOW_GUIDE` §3.1 defines three tiers — `locked` (deny, no route around), `ask` (consent), `gated`
(consent with TTL) — and §3.1 of the release it was copied from states that a consumer's `paths` block
**replaces** the product default rather than extending it. So the tier of any path is a literal string in
one file, matched in order, with no content awareness: a requirements document, a build script, a
changelog and a sprint board all fall to whatever the same prefix says.

Observed on this consumer, 2026-10-23:

| Probe | Result |
| :--- | :--- |
| written `SDLC/08.wbs/README.md` (board-status line) | denied |
| written `SDLC/08.wbs/03.revamp/03.program-board.md` | denied |
| written `bun.lock` (repo root, not in any tier) | allowed |
| written `apps/facade/src/…` (source, not in any tier) | allowed |

The denial is therefore about the **prefix**, not about whether the edit is a contract change. A
one-line "14 SP → 22 SP" correction and a rewrite of `AC-ATF-01` are the same event to the guard. That is
the designed behaviour of a prefix tier; it is recorded here because it decides who can keep the
artefacts truthful (see §4).

### 1.1 The policy file is not in version control

This is the part that makes the tier un-auditable, and it is stronger than F-09 in the earlier log
(which read `paths.gated` from the working tree and concluded `SDLC/**` was absent; on 2026-10-23 the
working tree **did** contain `SDLC/`, `sdlc/`, `scripts/ci/`, `.harness/`, `AGENTS.md`).

```
$ git ls-tree -r HEAD --name-only | rg '^\.harness/'
.harness/.gitignore
$ cat .harness/.gitignore
*
!.gitignore
!README.md
```

Consequences, each verified:

- **A fresh clone has no policy.** `/tmp/atf-pin` (clone of `HEAD` `5809fdb`) had no
  `.harness/decision-policy.json`; the pack falls back to `DEFAULT_ESO_POLICY.enforceWrites =
  "fail_closed"`, so a clean machine is strictly *more* locked than the author's machine, with no
  document saying so.
- **`git status` cannot report the loss.** The file is ignored, not deleted; after the 2026-10-23 session
  removed and restored `.harness/` entries the working tree still reported clean.
- **Two reviews read two different policies.** F-09 (2026-10-23) says `SDLC/**` is omitted; the same
  afternoon the file contained it. Neither observation is wrong; neither can be dated, because there is
  no commit to date it by.
- **`.harness/.gitignore` was edited in this session** (whitelist entries for `decision-policy.json`,
  `integrations.json`, `sidecar.env.example`, `WORKFLOW_GUIDE.md` were present in `HEAD` at `6818f7d`
  and removed by the time `HEAD` reached `5809fdb`). `git log` on the `.gitignore` shows the change, so
  the gate's own configuration was altered inside a session the gate was supposed to be supervising.

An agent asked to explain "why is `SDLC/` blocked" therefore cannot answer from evidence. Whatever it
reports is a snapshot of one machine's untracked state — which is the position this file's author was in
before finding the missing commit.

---

## 2. The evidence layer — the gate that is actually blocking

Path tier decides *that* a check applies. The evidence score decides *whether it passes*. On this
consumer it never does.

### 2.1 Effective configuration

`decision-policy.json` §`eso` at observation time:

```json
"eso": {
  "preflight": { "enabled": true },
  "mode": "hint",
  "cognition": { "enforceBrain": "fail_closed" }
}
```

`enforceWrites` is **absent**, and `resolveEnforceWrites()` treats absence as the default:

```js
function resolveEnforceWrites(rawEso = {}) {
  const raw = rawEso?.enforceWrites;
  if (ENFORCE_WRITES_VALUES.includes(raw)) return raw;
  // invalid values warn, then …
  return DEFAULT_ESO_POLICY.enforceWrites;   // "fail_closed"
}
```

So `mode: "hint"` reads as advisory while `enforceWrites: "fail_closed"` keeps the write gate shut. The
active verdict recorded by the hook is consistent with that:

```json
{ "mode": "fail_closed", "enforceWrites": "fail_closed",
  "level": "partial", "score": 0.6333,
  "closure": { "closed": 2, "required": 4, "allClosed": false } }
```

`buildTurnVerdict` sets `allowProtectedWrite = (level === "sufficient")` whenever `enforceWrites` is
`fail_closed`, so `partial` is denied — correctly, per the code. The question this section records is
whether `sufficient` is reachable here at all.

### 2.2 The two gaps that cannot be closed

Preflight `10:21:50Z` produced four gaps:

| Gap | Closed by |
| :--- | :--- |
| `law:harness-tooling` | — |
| `law:decision-facade` | — |
| `law:harness-eso` | ✅ (a read whose name matched) |
| `code:need at least 1 file read(s); have 0` | ✅ (first project-source read) |

Closure is `stemMatches()`: a gap closes when a tool call carries a **token that matches the gap's query
text** — a file path whose basename folds to it, or a `docgraph --q`/`Grep` argument containing it. It is
a name match, not a semantic one. Therefore:

```
$ rg -i 'harness-tooling|decision-facade' .
(no output)
```

Two strings that appear **nowhere in the repository** seed two gaps that only that string can close.
Every subsequent action the session could take — 30+ Shell reads, two `memory_smart_search` calls, four
`Read` calls on real source, one `codegraph_explore` whose name contains neither token — leaves closure
at `closed: 2, required: 4`. The probe that should have produced them is the `lawMisses` path: docgraph
returned zero rows for those queries, and the preflight recorded the **empty result as a required gap**
instead of as a miss.

This is the mechanism behind F-01/F-02 in the finso log ("`law:*` gap unclosable from a Shell/Markdown
turn"; "both `law:*` queries score 0"). Differently surfaced here: on atrievefin the terms are not merely
ranked low, they are absent from the corpus, so the gap is unsatisfiable rather than hard to satisfy.

### 2.3 The evidence actually read

The session did exactly what the guide's step 3 asks (memory → docgraph → codegraph) and what the
consumer's own rules require (`core.conversation-hygiene`: `memory_smart_search` first, `docgraph --q`
before a full `Read`, `codegraph_explore` before Grep). Measured:

- `docgraph --q "harness tooling"` → 2 rows (`AGENTS.md`, `.cursor/instructions.md`) — neither mentions
  the term; `harness-tooling` is not a concept in the index.
- `docgraph --q "decision facade"` → 9 rows, the top one `ATF-ADR-002`; but `decision-facade` as a token
  does not get a gap because the gap name is hyphenated.
- `docgraph --q "harness eso"` → 10 rows; this gap closed only because `.cursor/instructions.md` matched.
- `codegraph_explore("decision-facade")` → correct symbols (`FacadeEnv`, `errorEnvelope`, `loadEnv`,
  guard hooks), returned after the denial had already been decided.

So a session can hold the right documents in context — `AGENTS.md`, `ATF-API-001`, `ATF-WBS-002`,
`market`-grade source — and still be scored `0.6333` on bookkeeping it cannot influence. The evidence
layer here measures **query-string overlap**, and reports it as sufficiency.

---

## 3. The third layer — the brain gate

Independent of ESO, and able to deny on its own:

```json
"cognition": { "enforceBrain": "fail_closed" }
```

`guard-write.py` (`brain_attested()` → ledger first, then `.cursor/session/.pipeline-brain-stamp.json`
with `via ∈ {ask_deepseek_pro, ask_deepseek_flash_brain, ask_deepseek_flash_brain_fallback, direct_ide}`,
TTL 30 min) refuses when neither exists. On this host, in this session:

- the `project-0-atrievefin-deepseek-direct` MCP namespace was **not loaded**, so `ask_deepseek_pro`
  could not be called and no stamp could be produced;
- the existing stamp on disk was `2026-10-22T10:31Z`, ~24 h old, rejected on TTL;
- `.cursor/session/.direct-mode` was **absent**, so the `direct_ide` path was closed too.

Result: **two independent fail-closed gates with no self-service route.** The ESO gate is unsatisfiable
(§2.2); the brain gate is unsatisfiable because its only satisfying tool is not mounted; and the
documented escape (`BRAIN_UNAVAILABLE` → human waiver) is a human action. The session therefore produced
zero writes to `SDLC/`, and its output was moved to a chat message for the owner to apply — which is how
a machine-verifiable board drifted from 14 SP to 22 SP while every artefact that would have recorded it
stayed untouched.

The attestation split that makes the second layer reachable — verification of `allowWrite` when a
`mac` is present, but `allowWrite: true` **without** a signature being accepted when the ESO closure file
says `allClosed` — is F-10's territory and is not re-opened here.

---

## 4. Why a knowledge base lands in `gated`

The consumer's own law (`AGENTS.md`) defines `SDLC/` as the execution artefact tree:
`01.inception → 02.requirements → 03.analysis → 08.wbs → implement`. Under the tier model its children
are not one kind of object:

| Subtree | Property | Changes | Consequence of a wrong edit |
| :--- | :--- | :--- | :--- |
| `02.requirements`, `03.analysis` | contract with the customer | on a decision event | downstream work re-baselined |
| `04.architecture` | interface agreements | on a decision event | facade/kernel drift |
| `08.wbs` | **state** | every closed task | board lies about progress |
| `00.governance` | law of the consumer | rarely | rule of law changes |

Only three of the four need a gate. The fourth is *supposed to be written constantly*, and the gate is
right that it should be written with evidence — the argument recorded here is about **who can supply
that evidence**. On 2026-10-23 the evidence existed (`bun test` 63/0, `validate:packs` 3/3,
`verify:vendor` green, a clean-clone CI run), it was reproducible, and it still could not be *presented*
in the form the gate scores. The status line stayed at 14/65 until a human typed the commit.

That is the collision worth naming: the tier system treats "document" as a class, but a WBS is a
**record of verification**, and a record that can only be updated by the party not performing the
verification is a record that lags. The same session demonstrates it directly — the `R1.1`–`R1.5`
evidence went into git only when the human ran the commands from a chat reply.

Two smaller observations from the same window bear on it:

- **`.harness/**` was itself in `gated`** on this machine, so the policy that defines the tiers was
  simultaneously the thing being gated and the thing uncommitted (§1.1). A consumer cannot review its
  own tier configuration from the repository.
- **`SDLC/00.governance/03.decision-register.md` is reachable through the same prefix** as the sprint
  board. On 2026-10-23 the working-tree policy gated it; the earlier audit had it ungated and wrote a
  finding about it. Because the policy is untracked, both states are true on different machines.

---

## 5. Evidence index

| Item | Source |
| :--- | :--- |
| Preflight verdict (`10:21:50Z`, `insufficient`, `0`, `hint`/`fail_closed`, 4 gaps) | `.cursor/session/.eso-preflight.json` |
| Gap closure, final (`closed 2 / required 4`, `allClosed false`) | `.cursor/session/.eso-gap-closure.json` |
| Bundle stamp (`10:26:43Z`, `allowWrite false`, `partial`, `0.6333`) | `.cursor/session/.eso-bundle-stamp.json` |
| Tier configuration as observed | `.harness/decision-policy.json` (untracked) |
| Tier configuration as committed | `git ls-tree` → `.harness/.gitignore` only |
| Brain stamp (stale, `2026-10-22T10:31Z`) | `.cursor/session/.pipeline-brain-stamp.json` |
| Empty law queries | `docgraph --q "harness tooling" / "decision facade" / "harness eso"` |
| Absent gap tokens | `rg -i 'harness-tooling\|decision-facade'` → 0 |
| Consumer artefacts from the denied session | atrievefin commits `6818f7d` (content), `5809fdb` (VENDOR-041 fix) |

---

## 6. Scope note

Written on the owner's instruction to the `harness-eso` upstream tree, recording what happened in the
`atrievefin` consumer between 10:21Z and 11:15Z on 2026-10-23. It states mechanisms and observations. It
does not prescribe a fix, and it is not law, contract, or install instruction (see
[`README.md`](../README.md)).
