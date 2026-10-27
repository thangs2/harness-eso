# Brain gate vs. DSH — root cause, effect, and the proposed fix

**Status:** analysis only. No code changed. `guard-write.py` is untouched; `sdlc/` was not modified.
**Date:** 2026-10-27
**Owner of the fix:** the `harness-eso` session.
**Reported from:** a BA Platform session running on DeepSeek Harness (DSH), attempting to mount
`deepseek_direct.js` as an installable DSH bundle.

---

## 1. Summary

An agent running on DSH cannot pass the Brain gate, so it cannot write to any protected
path (`sdlc/`, `AGENTS.md`, `.cursor/rules/`, `backend/`, `apps/web/`, …), even after a real
DeepSeek Brain call has completed successfully.

The earlier diagnosis — *"the Brain stamp lands in `~/.dsh/sessions/` while the hook reads
`.cursor/session/` or `.agents/session/`"* — is **incomplete**. It is true that the session
directory differs, but the session stamp is **not the primary evidence path anymore**. The
primary path is the **DeepSeek usage ledger in product state**, and that path is already
machine-wide and independent of any IDE tree. The real gap is narrower than "wrong directory",
and the fix is correspondingly smaller.

This document records the chain: observation → mechanism → root cause → options → recommendation.

---

## 2. What was observed

### 2.1 The MCP server is healthy

`deepseek_direct.js` was probed directly with `bun`, bypassing both IDEs. MCP handshake and a
real end-to-end call both succeed:

```
initialize  -> {"serverInfo":{"name":"deepseek-direct-mcp","version":"2.6.0"},
                "capabilities":{"tools":{}}}
tools/list  -> ask_deepseek, ask_deepseek_pro, ask_deepseek_flash
tools/call  -> ask_deepseek_flash {"prompt":"Reply with exactly: OK"}
            -> {"content":[{"type":"text","text":"OK"}]}
               [deepseek-direct] executor model=deepseek-flash attempt=1 elapsed=0.6s http=200
```

So the server boots standalone, is protocol-conformant (MCP `2024-11-05`), and reaches the
DeepSeek API. The problem is not the server.

### 2.2 A side effect surfaced during that call

```
[deepseek-direct] usage ledger write failed: EPERM:
  operation not permitted, open '/Users/thangs2net/.harness/deepseek-usage.jsonl'
```

That file **exists** and is writable (`-rw-r--r--`, 45 KB, last written 2026-10-24). The EPERM
came from the DSH shell sandbox (`workspace-write`, so `~/.harness/` is outside the writable
set), not from a permission problem on the file.

This is the thread that leads to the root cause: **the Brain gate does not read the session
stamp first. It reads that ledger.** Anything that stops the ledger from being written silently
disables the gate's primary evidence path.

### 2.3 The gate denies a legitimate Brain call

Once `deepseek_direct` is mounted in DSH, a Brain call succeeds (2.1) but the following
protected write is denied with `DENY_ESO` / `DENY_BRAIN`. The agent has done the work the rules
ask for and is still blocked.

---

## 3. How the gate actually decides

From `.cursor/hooks/guard-write.py` (701 lines; `.cursor/` and `.agents/` copies are
byte-identical by design, `diff` confirms):

```python
# line 20-21 — session dir is derived from the hook's own location
HARNESS_DIR = Path(__file__).resolve().parents[1].name   # ".cursor" or ".agents"
SESSION_REL = f"{HARNESS_DIR}/session"
```

```python
# line 247-254 — product state, machine-wide, NOT per-tree
def product_state_dir() -> Path:
    override = os.environ.get("HARNESS_PRODUCT_STATE_DIR", "").strip()
    return Path(override) if override else Path.home() / ".harness"
```

```python
# line 496-518 — brain_attested(): the PRIMARY evidence path
def brain_attested() -> dict:
    """Did a Brain-tier model call complete recently?

    Read from the DeepSeek MCP server's usage ledger in product state — the only record of a
    model call that actually finished. The old check read `.pipeline-brain-stamp.json`, which the
    rules instruct the agent to write **itself**, so it attested nothing.
    """
    override = os.environ.get("DEEPSEEK_USAGE_LEDGER", "").strip()
    path_obj = Path(override) if override else (product_state_dir() / "deepseek-usage.jsonl")
```

```python
# line 579-585 — the decision order that matters
def brain_stamp_valid() -> bool:
    """Brain gate: the ledger first, the session stamp only as a fallback if enabled."""
    if brain_attested().get("ok"):
        return True
    if allow_session_stamp_fallback():
        return brain_attested_legacy()
    return False
```

```python
# line 674-680 — where a protected write is refused
if not hook_exempt(rel) and requires_brain_stamp(rel):
    if eso_fail_closed_blocks():
        deny(DENY_ESO)
        return 0
    if not brain_stamp_valid():
        deny(DENY_BRAIN)
        return 0
```

The ledger reader accepts a record as fresh Brain evidence when, within the last 30 minutes
(`STAMP_MAX_AGE_SECONDS`), it carries:

```python
# line 530
if str(rec.get("role") or "") not in ("pro", "brain_flash", "brain_fallback"):
    continue
```

Confirmed against the live ledger — records look like:

```json
{"ledger":1,"at":"2026-10-24T03:02:53.727Z","role":"pro",
 "promptSha256":"ceb27ab…","model":"deepseek-v4-pro","httpStatus":200,"outcome":"ok", …}
```

Relevant configuration in force (`.harness/decision-policy.json`):

```json
"eso": { "mode": "hint", "enforceWrites": "fail_closed",
         "cognition": { "enforceBrain": "fail_closed" } }
```

`paths.gated` includes `sdlc/`, `.harness/`, `AGENTS.md`, `.cursor/rules/`, `.agents/rules/`.

---

## 4. Root cause — three separate conditions, not one

The earlier summary collapsed these into one. They are distinct, and only one of them is
architectural.

### Condition A — the ledger is the real evidence path, and DSH can block its write

`brain_attested()` reads `~/.harness/deepseek-usage.jsonl` (or `$DEEPSEEK_USAGE_LEDGER`). This
path is already **tree-independent**: it does not care whether the agent runs under `.cursor`,
`.agents`, or DSH. The failure observed in 2.2 is a *write* failure, not a *read* failure: if the
harness sandbox denies the MCP child process access to `~/.harness/`, the ledger never gains the
record, `brain_attested()` returns `{}`, and the gate denies.

**This is the actual breakage**, and it is a sandbox/environment question rather than a hook
question.

### Condition B — the legacy session-stamp fallback cannot fire on DSH

```python
SESSION_REL = f"{HARNESS_DIR}/session"
```

`HARNESS_DIR` is derived from the hook file's own location, so the only two possible values are
`.cursor` and `.agents`. There is no third value and no override. DSH writes its sessions to
`~/.dsh/sessions/`, which therefore cannot be read by `brain_session_stamp()` or
`session_stamp()`.

Consequence: if (A) fails, (B) cannot rescue it. The two paths fail together on DSH. On Cursor or
Antigravity, (B) still rescues (A). **That asymmetry is why the problem looks like "DSH is
unsupported" rather than "the ledger did not get written".**

Note `HOOK_EXEMPT_PREFIXES` (line 35-38) is also tree-specific:

```python
HOOK_EXEMPT_PREFIXES = (".cursor/session/", ".agents/session/")
```

so DSH session artifacts would additionally be treated as ordinary gated paths.

### Condition C — ESO attestation also cannot be produced

`eso_fail_closed_blocks()` runs **before** the Brain check (line 675-677). It prefers a
product-state attestation written by the pack's preflight hook:

```python
# line 473-488
def eso_attestation() -> dict:
    """The pack's evidence verdict, from product state.
    Written by the pack's preflight hook — a hook, not a tool call — into a directory both
    guards deny writes to."""
    pid = project_id()
    if not pid:
        return {}
    return _read_json(product_state_dir() / "attest" / f"{pid}.json")
```

The preflight hook is part of the harness-eso **host pack**, wired through the IDE hook configs.
DSH is a third host with its own plugin mechanism (`harness-eso-dsh`); nothing in this
repository's `.cursor/hooks.json` or `.agents/hooks.json` runs on DSH. With `enforceWrites:
fail_closed`, an absent attestation blocks the write before the Brain gate is even consulted.

**So on DSH, today, a protected write is refused by the ESO gate first, not by the Brain gate.**
Fixing only the Brain path would still leave `sdlc/` unwritable.

---

## 5. Why the fix belongs in `guard-write.py` (and what must also change)

| Condition | Fixable in `guard-write.py`? | Why |
|---|---|---|
| **A** — ledger not written under DSH sandbox | **No** | The hook only *reads* the ledger. The write happens in the MCP server process. Fix is environment: `DEEPSEEK_USAGE_LEDGER` to a path inside the DSH-writable set, or widen the sandbox for that child. |
| **B** — session dir is binary (`cursor` \| `agents`) | **Yes** | `HARNESS_DIR` is derived from the hook's own path. A third tree needs an explicit resolution rule. |
| **C** — no preflight attestation on DSH | **Partly** | The hook can *tolerate* its absence, but producing one needs a DSH host adapter (the `harness-eso-dsh` plugin), or an explicit policy decision to accept ledger-only evidence on that tree. |

So: `guard-write.py` must change for **B**, and should change for **C**'s tolerance path. **A**
must be solved outside it. Changing only the hook would produce a gate that still fails, which is
worse than a gate that visibly fails — it would look fixed.

---

## 6. Proposed change to `guard-write.py`

Design constraints, taken from the file's own comments (these are load-bearing, not style
preferences):

- The two copies (`.cursor/`, `.agents/`) are **byte-identical** by design; the tree is derived
  from the hook's location so both stay in sync. Any change must preserve that property.
- `product_state_dir()` deliberately duplicates product logic rather than importing it, and is
  overridable by `HARNESS_PRODUCT_STATE_DIR` so an operator override cannot desynchronise the
  two. Follow the same shape: **one env-var override plus a derived default**.
- Product state must stay non-agent-writable (`in_product_state`, line 257-267). A session
  directory a hook accepts as evidence must not let the agent forge attestation.

### 6.1 Resolve the session directory instead of deriving a two-valued constant

Current:

```python
HARNESS_DIR = Path(__file__).resolve().parents[1].name
SESSION_REL = f"{HARNESS_DIR}/session"
```

Proposed: keep the derived default (so Cursor/Antigravity behaviour is bit-for-bit unchanged),
add one explicit override, and leave the tree derivation untouched:

```python
# Tree of the hook file: ".cursor" or ".agents". Unchanged for the two IDE trees.
HARNESS_DIR = Path(__file__).resolve().parents[1].name

# Session dir for this tree. Default preserves today's behaviour exactly. A third host that
# keeps sessions outside the repo (DSH: ~/.dsh/sessions) sets HARNESS_SESSION_DIR, absolute.
# Mirrors product_state_dir(): one env override, otherwise derived, so the two copies stay
# byte-identical and neither host needs its own fork of this file.
_SESSION_OVERRIDE = os.environ.get("HARNESS_SESSION_DIR", "").strip()
SESSION_REL = _SESSION_OVERRIDE or f"{HARNESS_DIR}/session"
```

Two consequences must be handled explicitly.

**(a) Paths built from `SESSION_REL`.** `STAMP_REL`, `BRAIN_UNAVAILABLE_REL` and
`DIRECT_MODE_REL` are joined as `ROOT / SESSION_REL`. With an absolute override, `pathlib`
discards `ROOT` silently — it works, but implicitly. Make it explicit:

```python
def session_path(name: str) -> Path:
    p = Path(SESSION_REL)
    return (p if p.is_absolute() else ROOT / p) / name

STAMP_PATH = session_path(".pipeline-brain-stamp.json")
BRAIN_UNAVAILABLE_PATH = session_path(".brain-unavailable.json")
DIRECT_MODE_PATH = session_path(".direct-mode")
```

Keep the `*_REL` **strings** only where they are used to *print* a path in the two denial
messages (`DENY_ESO`, `DENY_BRAIN`), so the text a model reads names the file it must actually
write.

**(b) `HOOK_EXEMPT_PREFIXES`.** An absolute, out-of-repo session dir is never reachable as a
repo-relative path, so the tuple needs no new entry. State that rather than assuming it, and
assert it:

```python
if Path(SESSION_REL).is_absolute():
    assert not Path(SESSION_REL).resolve().is_relative_to(ROOT), (
        "HARNESS_SESSION_DIR must lie outside the repo; an in-repo session dir would be "
        "reachable as a gated path and its exemption would be forgeable"
    )
```

Do **not** append `.dsh` or a wildcard to `HOOK_EXEMPT_PREFIXES`.

### 6.2 Make the Brain denial name the real cause

Today "ledger missing" and "stamp missing" collapse into one `DENY_BRAIN` string. On DSH that
message is actively misleading: it tells the agent to write a stamp the hook cannot read.

Proposed addition to the message (content, not layout):

```
Brain gate (fail-closed): protected path requires DeepSeek Brain first.
  ledger: <product_state>/deepseek-usage.jsonl — last Brain record: none within 30m
  session stamp: <SESSION_REL>/.pipeline-brain-stamp.json
  If the ledger is empty, the MCP server could not write it. Check that the harness sandbox lets
  the MCP child process reach product state, or set DEEPSEEK_USAGE_LEDGER to a writable path.
  Writing the session stamp will not help on this tree — the hook never read it.
```

The last sentence is the important one: without it, an agent under a fail-closed gate does
exactly the wrong thing — writes a stamp into a directory that is not read — and reports success.

### 6.3 Explicitly out of scope for this patch

- Do not add DSH to `HOOK_EXEMPT_PREFIXES` by string match.
- Do not relax the 30-minute window for one tree.
- Do not let a session stamp satisfy the gate on a tree where the stamp is agent-writable
  (line 476-483 records why: an incident had the agent overwrite `allowWrite` there).
- Do not touch `enforceWrites: fail_closed`. It is doing its job; the missing input is the
  problem, not the strictness.

---

## 7. Changes required **outside** `guard-write.py`

The hook patch alone will not make `sdlc/` writable on DSH. Two more pieces.

### 7.1 Ledger must reach product state (Condition A)

Options, cheapest first:

1. **Point the ledger into the writable set.** `DEEPSEEK_USAGE_LEDGER` already exists as an
   override (`guard-write.py:509`) and the MCP server already honours it
   (`deepseek_direct.js:298-302`). Set it to a path inside the DSH-writable set for that child
   process. Zero code change on either side.
2. **Widen the DSH sandbox** for the MCP child so `~/.harness/` is writable. Broader blast
   radius; prefer (1) unless the sandbox already permits it.

Verify with `wc -l ~/.harness/deepseek-usage.jsonl` before and after one Brain call: the line
count must increase. If it does not, the gate will deny and no amount of stamp-writing helps.

### 7.2 ESO attestation on DSH (Condition C)

Two honest choices:

- **Produce an attestation** — teach `harness-eso-dsh` to run the preflight and write
  `<product_state>/attest/<project_id>.json`, matching the shape the pack writes for the other
  two hosts. This is the real fix and belongs in the `harness-eso` DSH plugin, not the hook.
- **Declare DSH out of scope for ESO-gated writes** — an explicit, documented decision that DSH
  handles `question` / `docs-only` work while `dev-runtime` stays on Cursor/Antigravity. No code.
  Acceptable only if stated, not discovered later as a denial.

Without one of these, `eso_fail_closed_blocks()` denies before the Brain gate is consulted, and
the patch in §6 is unobservable.

---

## 8. Test plan for the `harness-eso` session

The patch must not regress the two working trees. Minimum:

| # | Case | Expected |
|---|---|---|
| 1 | Cursor tree, no override, ledger fresh | allow (unchanged) |
| 2 | Cursor tree, no override, ledger stale, valid session stamp | allow via legacy fallback (unchanged) |
| 3 | Antigravity tree, same as (2) | allow (unchanged) |
| 4 | Both trees, `HARNESS_SESSION_DIR` unset | `SESSION_REL` byte-identical to today |
| 5 | DSH tree, `HARNESS_SESSION_DIR` absolute, ledger fresh | allow — **the case this patch exists for** |
| 6 | DSH tree, `HARNESS_SESSION_DIR` absolute, ledger empty | deny, message names the ledger and says writing a stamp will not help |
| 7 | `HARNESS_SESSION_DIR` pointing inside the repo | explicit failure, not a silent exemption |
| 8 | `diff .cursor/hooks/guard-write.py .agents/hooks/guard-write.py` | identical |

Cases 1–4 are the regression guard; if any of them changes output, the patch is wrong.

---

## 9. Recommendation

1. **Fix A outside the hook first** (§7.1). One variable, and it is what actually blocks the gate
   today. Verify the ledger line count moves.
2. **Then patch the hook for B** (§6.1 + §6.2). Small, additive, preserves byte-identity, no
   behavioural change for the two shipped trees.
3. **Decide C explicitly** (§7.2). Either implement the DSH preflight adapter or state that DSH
   does not do gated writes yet. Do not leave it implicit, because the observed failure mode
   (denied with a Brain message) misattributes the cause to Brain.
4. **Do not** ask the BA Platform side to rename tools or hand-write stamps around this. Tool
   namespacing (`mcp__deepseek-direct__*`) is already handled in the rules, and writing a stamp
   is not a workaround for a missing ledger record — it is exactly the mistake §6.2 prevents.

Until 1–3 land, `dev-runtime` on DSH stays fail-closed by design, and the correct operating
stance is: **DSH for `question` / `docs-only`, Cursor or Antigravity for `dev-runtime`.**

---

## 10. Evidence index

| Claim | Where verified |
|---|---|
| MCP server healthy, 3 tools, end-to-end OK | direct `bun` probe of `~/.gemini/antigravity/deepseek_direct.js`, 2026-10-27 |
| Ledger read as `role ∈ {pro, brain_flash, brain_fallback}`, 30 min window | `guard-write.py:509-544` |
| Ledger preferred over session stamp | `guard-write.py:579-585` |
| Session dir derived from hook location, two values only | `guard-write.py:20-21` |
| Product state is `~/.harness`, env-overridable | `guard-write.py:247-254` |
| ESO gate runs **before** the Brain gate | `guard-write.py:674-680` |
| Attestation needs a preflight hook DSH does not run | `guard-write.py:473-488` |
| `fail_closed` in force for writes and Brain | `.harness/decision-policy.json` → `eso.enforceWrites`, `eso.cognition.enforceBrain` |
| `sdlc/` is gated | `.harness/decision-policy.json` → `paths.gated` |
| `.cursor` and `.agents` hook copies identical | `diff`, 701 lines each |
| Live ledger record shape | `~/.harness/deepseek-usage.jsonl`, tail read |
| Ledger write EPERM under DSH sandbox | stderr of the end-to-end probe, §2.2 |
