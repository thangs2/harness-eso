# DSH Brain gate — third report: the deadlock is now named

**Status:** one fix applied (`plugin.mjs`), one test suite added, bundle rebuilt.
**Date:** 2026-10-27
**Supersedes:** §4.1 and §6 of `dsh-brain-gate-run-report.md` (that recommendation is now implemented).
**Owner:** `harness-eso` session.

---

## 1. What this round changed

The second report proved a deadlock and recommended, as its highest-value item (§4.1), that the
plugin stop failing silently when a consumer declares `enforceWrites: fail_closed` but no
`eso.checks`. That is now implemented and tested.

Nothing was changed in `guard-write.py`, in `.harness/decision-policy.json`, or in `sdlc/`.
The gate is exactly as strict as it was. What changed is that the state which makes it
**unopenable** now says so.

---

## 2. The deadlock, restated in one paragraph

`agent/pre-step` did `if (!checks) return` — no attestation written, no message. `guard-write.py`
consults the ESO gate before the Brain gate, so it denied every protected write with `DENY_ESO`
against an `allowWrite: false` already on disk. An operator reading `ESO gate` makes a Brain call;
the witness records it correctly; `recordBrainCall` deliberately preserves the previous
`allowWrite` (`brain-attestation.mjs:115-136`, correct); nothing refreshes it, because the only
code that would (`agent/pre-step`) returned one branch earlier. Every message in that chain is
individually reasonable and none of them names the cause.

Measured on BA Platform, before the fix:

```
policy.eso.checks present : false
resolveEsoPolicy().checks : null
enforceWrites             : fail_closed
=> pre-step gate runs?    : NO — returns early at plugin.mjs:228
```

---

## 3. The fix

`packages/harness-eso-dsh/src/plugin.mjs`, in the `agent/pre-step` handler:

```js
const policy = loadDecisionPolicy({ root }).policy ?? {};
const eso = resolveEsoPolicy(policy);
const checks = declaredChecks ?? eso.checks;
if (!checks) {
    if (!noChecksWarned && eso.enforceWrites === 'fail_closed') {
        noChecksWarned = true;
        log(
            'pre-step: no eso.checks declared for this consumer, and eso.enforceWrites is ' +
                'fail_closed. The evidence attestation will not be written, so ' +
                'guard-write.py keeps whatever allowWrite the attestation already holds — ' +
                'protected writes will be denied with "ESO gate" even after a successful ' +
                'Brain call. Declare eso.checks in .harness/decision-policy.json, or raise ' +
                'eso.enforceWrites, or accept that this host does not do gated writes.',
        );
    }
    return decision;
}
```

with `let noChecksWarned = false;` in the `apply` scope.

Four deliberate choices, each with a reason that is not "it seemed fine":

| Choice | Why |
|---|---|
| **Only when `enforceWrites === 'fail_closed'`** | With `off`, no write is refused, so the condition has no consequence. A warning about a gate that will not act is noise. |
| **Once per session (`noChecksWarned`)** | The condition is a standing configuration fact. A line per step trains an operator to skip the one line that explains their refusals. |
| **The message names the symptom `"ESO gate"`** | The operator's actual observation is that string. Naming it is what connects their symptom to this cause. |
| **Three remedies, including "accept"** | Declaring checks is not always the right answer. Stating the third option prevents the reader from concluding the plugin is simply broken. |

The warning does **not** change the decision. It is a diagnostic, not a gate change — which is why
it is safe to ship without a policy decision from the consumer side.

---

## 4. Tests

New: `qc/dsh-no-checks-deadlock.test.mjs`, 5 cases, all passing. It drives the real
`agent/pre-step` handler through `createEsoDshPlugin`, not a copy of the logic.

| Case | Asserts |
|---|---|
| `fail_closed` + no checks | exactly one diagnostic, and it names the cause, the `"ESO gate"` symptom, the policy file, and `enforceWrites` |
| five entering steps | still exactly one line |
| row config supplies `checks` | silent — the condition does not apply |
| `enforceWrites: off` | silent |
| `eso.enabled: false` | no crash; any warning must still describe the resolved enforcement |

Full related suite — `dsh-eso-plugin`, `dsh-attestation`, `dsh-brain-witness`, `check-brain`,
`brain-gate-dsh`, `session-dir-override`, `stamp-write-exempt`, plus the new file:

```
ℹ tests 72
ℹ pass 72
ℹ fail 0
```

Bundle rebuilt: `dist/eso-plugin.mjs` 49.0 KB, `grep -c "no eso.checks declared"` → 1.

### 4.1 One correction to a test I wrote mid-round

A first attempt asserted "no warning when `enforceWrites` is not `fail_closed`" using
`enforceWrites: 'hint'`. That value is **not accepted** — `eso-policy.mjs` warns
`eso.enforceWrites = "hint" is not valid (use "fail_closed" or "off")` and resolves it to
`fail_closed`, so the warning correctly fired and the test failed. The test was wrong, not the
code; re-run with `off` it passes. Recorded because the same mistake is easy to make when writing
a consumer policy by hand: `mode` accepts `hint`, `enforceWrites` does **not**, and the two look
interchangeable.

---

## 5. What is still blocking a protected write on DSH

The deadlock is now **visible**, not resolved. The fix does not make `sdlc/` writable; it makes the
reason legible.

```
attestation allowWrite=false (baplatform, 2026-10-23, no "source")
  → DENY_ESO, every time
  → now: preceded by one log line naming this exact state
```

To actually open the gate, the consumer must do one of the three things the message lists:

1. **Declare `eso.checks`** in `.harness/decision-policy.json`. A check-only verdict can then reach
   `allowWrite: true` through `attestation.mjs`. This is the only path that keeps `fail_closed`.
2. **Raise `eso.enforceWrites`** to `off` for this tree. Weaker gate, stated explicitly.
3. **Accept** that DSH does not do gated writes; keep `dev-runtime` on Cursor/Antigravity.

That is a policy decision about BA Platform's gate strictness. It is **not** made here, and should
not be made by an agent.

---

## 6. Remaining open items, in priority order

1. **§4.2 of the previous report is still open** — no freshness rule on an attestation. A
   three-day-old `allowWrite: false` blocks exactly as hard as a one-minute-old one. Worth deciding
   whether an attestation past its own `ttlSec` (600 s) should deny or fall through.
2. **`witness` absent from the report** (previous §5.1) — `check brain` shows the witness field only
   when `witness.used` is true, so a DSH consumer whose plugin has not fired reports
   `[ledger-stale]`, which reads as a ledger fault. A `brain-witness-absent` finding (raised when
   `source === 'dsh-plugin-checks'` but no `brain` record) would name the real condition. Not
   implemented.
3. **Restart required** — the profile links the package by path, but a running DSH keeps the
   composition it booted. `dist/eso-plugin.mjs` at 11:48 does nothing until restart.
4. **`mcp__deepseek-direct__*` must exist** before the witness has anything to observe. The
   `deepseek-direct` bundle is not installed in the running profile as of this report.

---

## 7. Evidence index

| Claim | Where verified |
|---|---|
| `agent/pre-step` returned silently at `if (!checks) return` | `plugin.mjs` (pre-fix), line 228 |
| `resolveEsoPolicy(...).checks === null` for BA Platform | executed against `.harness/decision-policy.json` |
| `normaliseChecks(undefined) === null` | `eso-policy.mjs:92-93` |
| ESO gate precedes the Brain gate | `guard-write.py:674-680` |
| `recordBrainCall` preserves prior `allowWrite` | `brain-attestation.mjs:115-136` |
| Diagnostic fires exactly once, only for `fail_closed` + no checks | `qc/dsh-no-checks-deadlock.test.mjs`, 5/5 |
| No regression across the related suites | 72/72 pass |
| `enforceWrites: "hint"` is invalid and resolves to `fail_closed` | mid-round test failure, `eso-policy.mjs` warning |
| Diagnostic present in the built artifact | `grep` on `dist/eso-plugin.mjs`, 49.0 KB, 2026-10-27 11:48 |
