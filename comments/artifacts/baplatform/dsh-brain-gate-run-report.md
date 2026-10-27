# DSH Brain gate — second report: what actually happens when you run it

**Status:** analysis + one applied CLI patch. No change to `guard-write.py`; `sdlc/` untouched.
**Date:** 2026-10-27 (supersedes parts of `brain-gate-dsh-root-cause.md`)
**Owner:** `harness-eso` session.

---

## 1. What changed since the first report

The first report (`brain-gate-dsh-root-cause.md`) proposed three conditions A/B/C and, for
Condition C, listed "supply an attestation from the DSH plugin" as the fix. That fix has since been
written (`packages/harness-eso-dsh/src/attestation.mjs`, `brain-attestation.mjs`) and the code
is good. **But running it end to end showed that writing the attestation is not sufficient**,
for a reason none of A/B/C named.

**One correction to the first report, stated plainly.** Its §7.1 recommended pointing
`DEEPSEEK_USAGE_LEDGER` at a path inside the workspace so the MCP child could write it. **That
recommendation was wrong and has been withdrawn.** Any ledger the MCP child can write inside a
workspace is a ledger the agent can append to, which makes it forgeable evidence for the gate it
is supposed to satisfy. The new module's docblock records exactly this reasoning
(`brain-attestation.mjs:13-15`). Nothing in this report reintroduces it.

---

## 2. What was verified working

### 2.1 Build

```
$ node scripts/build-dsh-plugin.mjs
dsh plugin → packages/harness-eso-dsh/dist
  eso-plugin.mjs  48.4 KB  (0 external imports)
  cordis.patch.yml  row harness-eso → ./dist/eso-plugin.mjs
```

Witness code is present in the compiled bundle:

```
tools/post-execute listener : 1
BRAIN_TOOLS                 : mcp__deepseek-direct__ask_deepseek,
                              mcp__deepseek-direct__ask_deepseek_pro
recordBrainCall, brainRecordFor, via: "dsh-plugin" : present
```

`ask_deepseek_flash` is correctly **excluded** from `BRAIN_TOOLS` — the comment at
`brain-attestation.mjs:46-50` explains why, and it is right.

### 2.2 The witness branch of `check brain` fires correctly

`--consumer` did not exist as a flag, so `checkBrain({ consumer })` — which already accepted it —
was unreachable. Patched (§5). With a temporary Brain record injected into
`~/.harness/attest/baplatform.json` (then restored from backup):

```
Brain evidence  PASS
  ledger    /Users/thangs2net/.harness/deepseek-usage.jsonl (product state)
  brain rows 84  newest 2026-10-24T03:02:53.727Z (265174s)
  witness   ask_deepseek_pro (4s, source unknown)
  window    1800s
```

The report shape the operator needs is correct: **PASS with a witness line naming
`ask_deepseek_pro`**, even while the ledger is three days stale. The witnessed path genuinely
overrides the ledger, as `check-brain-cmd.mjs:143-160` intends.

### 2.3 Tests

`qc/check-brain.test.mjs` 9/9. `brain-gate-dsh.test.mjs`, `dsh-brain-witness.test.mjs`,
`session-dir-override.test.mjs` 18/18. Notably `session-dir-override.test.mjs` already asserts
that an **in-repo** session-dir override is refused, not honoured — the same guarantee the
ledger needs, applied to the session dir.

---

## 3. Why it still will not let a write through — the new finding

This is the part the first report did not have, and it is the one that matters when someone runs
the pipeline.

### 3.1 The chain, end to end

`guard-write.py:674-680` checks the ESO gate **before** the Brain gate:

```python
if not hook_exempt(rel) and requires_brain_stamp(rel):
    if eso_fail_closed_blocks():   # ← runs first
        deny(DENY_ESO)
        return 0
    if not brain_stamp_valid():    # ← never reached
        deny(DENY_BRAIN)
        return 0
```

`eso_fail_closed_blocks()` prefers `<product-state>/attest/<pid>.json`
(`guard-write.py:473-488`). The current file for this consumer:

```json
{ "ok": true, "projectId": "baplatform", "at": "2026-10-23T03:39:19Z",
  "level": "partial", "allowWrite": false, "enforceWrites": "fail_closed",
  "source": <absent> }
```

`allowWrite: false` → `DENY_ESO`. The Brain witness is never consulted, no matter how fresh it is.

So who refreshes `allowWrite` to `true`? The plugin's `agent/pre-step` handler. And:

```js
// plugin.mjs:227-228
const checks = declaredChecks ?? resolveEsoPolicy(policy).checks;
if (!checks) return decision;          // ← returns BEFORE writing any attestation
```

### 3.2 `checks` resolves to `null` for this consumer — proven, not assumed

```js
// eso-policy.mjs:92-93
export function normaliseChecks(raw) {
    if (!raw || typeof raw !== 'object') return null;
```

Measured against the real policy:

```
policy.eso.checks present : false
resolveEsoPolicy().checks : null
enforceWrites             : fail_closed
=> pre-step gate runs?    : NO — returns early at plugin.mjs:228
```

`.harness/decision-policy.json` has `eso.enabled`, `eso.mode: "hint"`,
`eso.enforceWrites: "fail_closed"`, `eso.thresholds`, `eso.preflight`, `eso.cognition` — and
**no `checks` key**.

### 3.3 The resulting deadlock

```
attestation allowWrite=false (2026-10-23)
  → guard denies with DENY_ESO
  → operator makes a Brain call
  → witness records `brain` into the same document, but recordBrainCall deliberately
    preserves the previous allowWrite (brain-attestation.mjs:115-136 — correct)
  → plugin pre-step would refresh allowWrite, but checks === null, so it returns early
  → allowWrite stays false forever
  → DENY_ESO forever
```

The Brain witness works. It is simply behind a gate that can never open.

**The operator sees `ESO gate` and concludes "evidence gate still blocking, Condition C not
done".** That reading is correct about the symptom and wrong about the cause: the attestation
writer exists and runs; it is the *verdict* half that is never produced, because the consumer
declares no checks.

---

## 4. Assessment — whose defect is this?

Three defensible readings. They are listed in the order this report recommends acting on them.

### 4.1 The plugin's default is silent, and silence looks like success

`declaredChecks = config.checks ?? defaults.checks ?? null` and then `if (!checks) return`.
A consumer with no `eso.checks` gets **no attestation and no diagnostic**. Compare with
`attestation.mjs`, whose header is explicit that "nothing on DSH ever wrote it" was a real defect —
the same class of defect now sits one branch earlier, unlogged.

Recommendation: when `checks` is null **and** the guard's `enforceWrites` is `fail_closed`, log
once per session, e.g.

```
eso: no eso.checks declared for this consumer — the evidence attestation will not be written,
     and guard-write.py will deny protected writes on the attestation that is already on disk.
     Declare eso.checks in .harness/decision-policy.json, or accept that this host cannot do
     gated writes.
```

This is the single highest-value change here: it converts a silent deadlock into an instruction.

### 4.2 A stale `source`-less attestation is treated as authoritative forever

The file above was minted by the pack on 2026-10-23 with `allowWrite: false` and **no `source`
field**. `receiptMatchesVerdict` (`attestation.mjs:114-127`) already knows that an absent `source`
means "the pack" and refuses to clobber it — a deliberate, defensible choice for a *fresher*
receipt. But there is no freshness rule anywhere: a three-day-old `allowWrite: false` blocks just
as hard as a one-minute-old one, and the DSH plugin is structurally unable to replace it
(§3.2). Worth deciding: does an attestation older than its own `ttlSec` (600 s) still deny, or
does it fall through to the session-stamp path? Currently it denies.

### 4.3 The consumer declares `enforceWrites: fail_closed` without declaring checks

`.harness/decision-policy.json` sets `enforceWrites: "fail_closed"` but supplies no `eso.checks`.
Under that combination, the evidence gate has no way to produce a positive verdict on **any**
host, not just DSH — Cursor and Antigravity only pass because the pack measures sufficiency
through docgraph/codegraph, which DSH cannot reach. So this is a consumer configuration question
as much as a plugin one.

Recommendation: the consumer must do one of two things, explicitly —

- declare `eso.checks` (contract / migration / other named findings) so a check-only verdict can
  reach `allowWrite: true`, or
- set `eso.mode` / `enforceWrites` to something other than `fail_closed` for this tree and accept
  a weaker gate.

Neither is a code change here. Both need to be stated rather than discovered at denial time.

---

## 5. Applied change: `harnessctl check brain --consumer <path>`

`checkBrain({ consumer })` and `readWitnessedBrain(consumer)` always accepted a consumer root, but
`runCheckBrain` parsed only `--json`, so the parameter was unreachable and the only way to inspect
another consumer was to `cd` into it. That mattered precisely because the witnessed half of the
report reads `<consumer>/harness.config.json` for the project id and
`<product-state>/attest/<pid>.json` for the record: run from the wrong directory and the report
says `used: false` — a missing-argument bug wearing the costume of "no witness".

`packages/harness-cli/src/check-brain-cmd.mjs` now accepts `--consumer <path>` and
`--consumer=<path>`, rejects a missing value (`--consumer requires a path`), and keeps
`unknown flag: …` for anything else. `cli.mjs` usage line updated to match.

Verified:

```
$ cd /tmp && harnessctl check brain --consumer /Users/thangs2net/Workspaces/baplatform
Brain evidence  FAIL
  ledger  /Users/thangs2net/.harness/deepseek-usage.jsonl (product state)
  brain rows 84  newest 2026-10-24T03:02:53.727Z (265134s)
  window 1800s
  [ledger-stale]
```

`qc/check-brain.test.mjs` still 9/9.

### 5.1 One follow-on worth considering

`witness` appears in the report **only** when `witness.used === true`. For a DSH consumer whose
plugin has not yet recorded anything, the report silently falls through to the ledger branch and
reports `[ledger-stale]` — which reads as "the ledger is broken" rather than "the witness has not
fired yet". A finding like `brain-witness-absent` (raised when the attestation's `source` is
`dsh-plugin-checks` but it carries no `brain` record) would name the actual condition. Not
implemented; flagged because it is the same misattribution problem as §4.1, in the report rather
than the log.

---

## 6. What an operator should do, in order

1. **Restart DSH after building.** The profile links `harness-eso-dsh` by path
   (`~/.dsh/profiles/desktop/node_modules/@mu/harness-eso-dsh`), but the running process keeps the
   composition it booted. A rebuilt `dist/eso-plugin.mjs` does nothing until restart.
2. **Mount the DeepSeek MCP bundle** so `mcp__deepseek-direct__ask_deepseek_pro` exists. Without
   it the witness has nothing to observe.
3. **Decide the `eso.checks` question (§4.3).** Until it is decided, a protected write on DSH is
   denied at the ESO gate and no amount of Brain calling changes that.
4. Then run:

```
harnessctl check brain --consumer <consumer-path>
```

and read the denial text, not the dashboard:

| Denial | Meaning |
|---|---|
| `ESO gate (fail-closed)` | `allowWrite: false` on disk and nothing refreshed it → §3.2. **Not** a Brain problem. |
| `Brain gate` | The ESO gate passed, so `checks` are declared — the witness did not fire. Look for `brain: recorded …` / `brain: attestation not written — …` in the plugin log. |
| `brain-witness-stale` finding | The witness works; the record is older than 1800 s. Make one `ask_deepseek_pro` call. |

---

## 7. Evidence index

| Claim | Where verified |
|---|---|
| Witness listener compiled into the bundle | `grep` on `dist/eso-plugin.mjs`, 2026-10-27 |
| `ask_deepseek_flash` excluded from Brain tools | `brain-attestation.mjs:52-55`, rationale 46-50 |
| `recordBrainCall` preserves prior `allowWrite` | `brain-attestation.mjs:115-136` |
| ESO gate runs before the Brain gate | `guard-write.py:674-680` |
| Guard prefers product-state attestation | `guard-write.py:473-488` |
| `baplatform` attestation is `allowWrite: false`, 2026-10-23, no `source` | `~/.harness/attest/baplatform.json` |
| `normaliseChecks(undefined) === null` | `eso-policy.mjs:92-93` |
| `resolveEsoPolicy(<real policy>).checks === null` | executed against `.harness/decision-policy.json` |
| `pre-step` returns before writing when `checks` is null | `plugin.mjs:227-228` |
| `.harness/decision-policy.json` has no `eso.checks` key | file read, 112 lines |
| Witness branch reports PASS with a named witness line | temporary record injected, report captured, original restored |
| `--consumer` unreachable before the patch | `runCheckBrain` parsed only `--json` |
| In-repo session-dir override refused | `qc/session-dir-override.test.mjs`, 18/18 pass |
