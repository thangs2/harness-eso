#!/usr/bin/env python3
"""Deny agent writes to mu bible law, secrets, and paths without Brain stamp."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK_FILE = Path(__file__).resolve().parent / "locked-paths.txt"

# Which harness tree this hook lives in: `.cursor` for Cursor, `.agents` for
# Antigravity. Derived from the hook's own location, so the two copies stay
# BYTE-IDENTICAL while each gates its OWN session directory. Both used to be
# hardcoded to `.cursor/session/`, which meant an Antigravity session could
# never satisfy its own gate and `.agents/session/.pipeline-brain-stamp.json`
# was written but never read.
HARNESS_DIR = Path(__file__).resolve().parents[1].name
# Session dir for this tree. The default stays derived, so Cursor and Antigravity keep the exact
# paths they already had. A third host that keeps sessions outside the repo — DSH writes
# `~/.dsh/sessions` — sets `HARNESS_SESSION_DIR` to an ABSOLUTE path. That is the same shape as
# `product_state_dir()`: one env override, otherwise derived, so no host needs its own fork of this
# file and the two in-repo copies stay byte-identical. What sets it is the tree's own hook config.
_SESSION_OVERRIDE = os.environ.get("HARNESS_SESSION_DIR", "").strip()
SESSION_REL = _SESSION_OVERRIDE or f"{HARNESS_DIR}/session"


def session_path(name: str) -> Path:
    """A file inside this tree's session dir.

    With an absolute `HARNESS_SESSION_DIR`, `ROOT / SESSION_REL` silently discards `ROOT`. It works,
    but only as an accident of `pathlib` rather than as a stated rule, and the next person to join a
    path by hand would get the in-repo answer. One resolver, so there is one rule.
    """
    base = Path(SESSION_REL)
    return (base if base.is_absolute() else ROOT / base) / name


STAMP_NAME = ".pipeline-brain-stamp.json"
STAMP_REL = f"{SESSION_REL}/{STAMP_NAME}"
STAMP_PATH = session_path(STAMP_NAME)
ESO_STAMP_NAME = ".eso-bundle-stamp.json"
BRAIN_UNAVAILABLE_NAME = ".brain-unavailable.json"
BRAIN_UNAVAILABLE_REL = f"{SESSION_REL}/{BRAIN_UNAVAILABLE_NAME}"
BRAIN_UNAVAILABLE_PATH = session_path(BRAIN_UNAVAILABLE_NAME)
DIRECT_MODE_NAME = ".direct-mode"
DIRECT_MODE_REL = f"{SESSION_REL}/{DIRECT_MODE_NAME}"
DIRECT_MODE_PATH = session_path(DIRECT_MODE_NAME)
STAMP_MAX_AGE_SECONDS = 30 * 60
BRAIN_VIA = frozenset({
    "ask_deepseek_pro",
    "ask_deepseek_flash_brain",
    "ask_deepseek_flash_brain_fallback",
    "direct_ide",
})

HOOK_EXEMPT_PREFIXES = (
    ".cursor/session/",
    ".agents/session/",
    ".claude/session/",
)

# An out-of-repo session dir is never reachable as a repo-relative path, so it needs no entry here:
# the exemption tuple is matched against paths the agent writes *inside* the repo. Do not append
# `.dsh` or a wildcard — an in-repo session dir would be forgeable, which is why the override is
# refused rather than merely ignored.
if Path(SESSION_REL).is_absolute():
    _session_abs = Path(SESSION_REL).resolve()
    if _session_abs == ROOT or ROOT in _session_abs.parents:
        raise SystemExit(
            "HARNESS_SESSION_DIR must lie outside the repo: an in-repo session dir is reachable as a "
            f"gated path and its exemption would be forgeable (got {SESSION_REL}, root {ROOT})"
        )

SECRET_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
}
SECRET_SUFFIXES = (".pem", ".pfx", ".p12", ".key")
PRIVATE_KEY = re.compile(r"BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY")
AWS_KEY = re.compile(r"AKIA[0-9A-Z]{16}")

DENY_ESO = (
    "ESO gate (fail-closed): evidence sufficiency insufficient for protected writes. "
    "Improve context (docgraph/codegraph), set eso.mode=hint/observe, or human HIL. "
    f"Stamp: {SESSION_REL}/{ESO_STAMP_NAME}"
)


def deny_eso_message() -> str:
    """`DENY_ESO`, plus what actually refused (§G-12).

    The old text offered three remedies and none of them could be executed by the party reading it: the
    evidence gate ignores `eso.mode` (it reads `enforceWrites`), docgraph closes no `law` gap the corpus
    does not contain, and HIL consent covers `ask` / `gated`, not evidence. It also named the *session*
    stamp while the decision came from product state, and product state is written on every preflight.

    Every sentence here is a fact read from the verdict: which gate, whether the key was defaulted, which
    gap is closable by nothing, and — when the verdict is simply stale — the one action that helps.
    """
    verdict = eso_verdict()
    reasons = verdict.get("reasons") or []
    level = verdict.get("level") or "unknown"
    label = "attestation (product state)" if verdict.get("source") == "attestation" else "session stamp (legacy)"
    parts = [f"ESO gate (fail-closed): protected write refused. Verdict: {label}."]
    # Each branch answers the same question — "what would unblock THIS write" — so a branch must not
    # borrow another's advice. A stale receipt was told to close evidence gaps that describe a turn
    # already over; that reads as two problems when there is one.
    if "unattributable" in reasons:
        parts.append(
            "The attestation failed its MAC check — it was edited outside product state. "
            "Run preflight again (submit a prompt) so the hook rewrites it."
        )
    elif "repo_changed" in reasons:
        parts.append(
            "The working tree changed since this verdict was minted (a write landed after preflight measured it), "
            "so the evidence no longer describes the files on disk. Submit a prompt to re-measure, then retry."
        )
    else:
        unanswerable = verdict.get("unanswerable") or []
        # The rule the gate actually enforces (`gate.mjs`, G-02): on `partial` the gaps that hold the
        # write are the *closable* ones. "Every reported gap" while the gate had already exempted the
        # unclosable ones is how atrievefin's reader was sent to look for documents its repo does not
        # contain — the refusal was right, the instruction was not.
        if unanswerable:
            parts.append(f"Evidence level: {level}; a `partial` publishes once every closable gap is closed.")
            parts.append(
                "These gaps cannot be closed by any reading in this repo — they are reported, not required: "
                + ", ".join(unanswerable)
                + "."
            )
        else:
            parts.append(f"Evidence level: {level}; a `partial` publishes only when every reported gap is closed.")
        if verdict.get("jevOnPartial") and level == "partial":
            parts.append(
                "This consumer sets `eso.preflight.jevOnPartial: true`, so a `partial` publishes nothing "
                "however many closable gaps are closed — only `sufficient` (or a policy change) reopens the write."
            )
        else:
            parts.append(
                "Close the remaining gaps (read the files the preflight lists, then re-run the query it names), or ask "
                "the operator to change the policy."
            )
        # `enforceWrites` explains *why the gate is on*, which only matters when the level is the reason
        # it refused. A stale or forged receipt is a different problem with a different fix.
        if verdict.get("defaulted"):
            parts.append(
                "`enforceWrites` was NOT written in .harness/decision-policy.json; the strict default `fail_closed` is in force. "
                "Setting `eso.mode` does not change this — write `enforceWrites` explicitly if that is not what you want."
            )
        else:
            parts.append("`enforceWrites: fail_closed` was declared in the consumer policy.")
    return " ".join(parts)

DENY_BRAIN = (
    "Brain gate (fail-closed): protected path requires DeepSeek Brain first. "
    "Call ask_deepseek_pro (or [BRAIN FALLBACK] ask_deepseek_flash), then write "
    f"{STAMP_REL}. "
    "If MCP is down, write "
    f"{BRAIN_UNAVAILABLE_REL} "
    "and tell the user BRAIN_UNAVAILABLE — do not bypass silently."
)


def ledger_path() -> Path:
    """The DeepSeek usage ledger — the Brain gate's primary evidence. Same rule as `brain_attested`."""
    override = os.environ.get("DEEPSEEK_USAGE_LEDGER", "").strip()
    return Path(override) if override else (product_state_dir() / "deepseek-usage.jsonl")


def deny_brain_message() -> str:
    """`DENY_BRAIN`, split by actual cause.

    "ledger missing" and "stamp missing" used to collapse into one sentence, and that sentence told the
    reader to write a stamp. On a tree whose session dir the hook does not read — DSH, until this patch —
    the advice was not just useless: it made an agent under a fail-closed gate do the wrong thing, write
    a file nobody reads, and report success. So the message names the ledger first, because it is the
    primary path, and says when a stamp cannot help.
    """
    if brain_from_attestation().get("ok") or brain_attested().get("ok"):
        return DENY_BRAIN
    ledger = ledger_path()
    try:
        ledger_size = ledger.stat().st_size
    except OSError:
        ledger_size = -1
    attest_src = (eso_attestation() or {}).get("source")
    ledger_text = (
        "unreadable (absent, or the sandbox denied the hook)"
        if ledger_size < 0
        else f"{ledger_size} bytes"
    )
    if attest_src and attest_src != "pack":
        # This host records the call itself. Telling the reader about the ledger here would send it to a
        # file its own sandbox prevents anyone from writing — a dead end dressed as a remedy.
        return " ".join(
            [
                "Brain gate (fail-closed): protected path requires DeepSeek Brain first.",
                f"This host attests Brain calls through the host plugin ({attest_src}); nothing has been "
                "recorded for this session in the last 30 minutes.",
                "Call a Brain-tier tool (ask_deepseek_pro, or ask_deepseek_flash_brain through ask_deepseek) "
                "and retry — a call that returned successfully is recorded automatically, so there is no "
                "stamp to write.",
                f"The ledger route is not used on this host (it reads {ledger} — {ledger_text}), and writing "
                "the session stamp will not help: the gate never read it here.",
            ]
        )
    parts = [
        "Brain gate (fail-closed): protected path requires DeepSeek Brain first.",
        f"ledger: {ledger} — {ledger_text}; no Brain record within 30m.",
        f"session stamp: {STAMP_PATH}",
        "If the ledger is empty, the MCP server could not write it: check that the harness sandbox lets the "
        "MCP child process reach product state, or set DEEPSEEK_USAGE_LEDGER to a path it can write.",
        "Writing the session stamp will not help — this hook reads the ledger first and has never read a stamp "
        "from this tree.",
    ]
    return " ".join(parts)

_OUTPUT_SHAPE = "cursor"


def detect_shape(data: dict) -> str:
    tree = str(os.environ.get("HARNESS_TREE") or "").strip().lower()
    if tree == "agents":
        return "antigravity"
    if tree == "claude":
        return "claude"
    if not isinstance(data, dict):
        return "cursor"
    if data.get("transcript_path") or data.get("permission_mode"):
        return "claude"
    ev = str(data.get("hook_event_name") or data.get("hookEventName") or "")
    if ev in ("UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact"):
        if data.get("session_id") and data.get("cwd"):
            return "claude"
    if data.get("hook_event_name") or data.get("hookEventName"):
        return "cursor"
    if isinstance(data.get("toolCall"), dict):
        return "antigravity"
    if data.get("conversationId") and data.get("stepIdx") is not None:
        return "antigravity"
    return "cursor"


def extract_tool_input(data: dict) -> dict:
    if not isinstance(data, dict):
        return {}
    for key in ("tool_input", "input", "arguments"):
        val = data.get(key)
        if isinstance(val, dict):
            if val.get("path") or val.get("file_path") or val.get("target_file") or val.get("notebook_path"):
                p = val.get("path") or val.get("file_path") or val.get("target_file") or val.get("notebook_path")
                c = val.get("contents") or val.get("new_string") or val.get("content") or val.get("new_cell") or ""
                if not c and isinstance(val.get("edits"), list):
                    c = "\n".join(str(e.get("new_string", "")) for e in val["edits"] if isinstance(e, dict))
                return {"path": p, "contents": c}
    call = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    path = ""
    for pk in ("path", "file_path", "target_file", "AbsolutePath", "TargetFile", "notebook_path"):
        if isinstance(args.get(pk), str) and args[pk]:
            path = args[pk]
            break
    contents = ""
    for ck in ("contents", "new_string", "content", "NewContent", "text", "body", "CodeContent", "ReplacementContent"):
        if ck in args and args[ck] is not None:
            contents = args[ck]
            break
    if not contents and isinstance(args.get("ReplacementChunks"), list):
        contents = "\n".join(str(chunk.get("ReplacementContent", "")) for chunk in args["ReplacementChunks"] if isinstance(chunk, dict))
    if not contents and isinstance(args.get("edits"), list):
        contents = "\n".join(str(e.get("new_string", "")) for e in args["edits"] if isinstance(e, dict))
    if path or contents:
        return {"path": path, "contents": contents}
    return {}


def allow():
    if _OUTPUT_SHAPE == "antigravity":
        sys.stdout.write('{"decision":"allow"}\n')
    elif _OUTPUT_SHAPE == "claude":
        sys.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n')
    else:
        sys.stdout.write('{"permission":"allow"}\n')


def deny(message: str):
    if _OUTPUT_SHAPE == "antigravity":
        sys.stdout.write(json.dumps({"decision": "deny", "reason": message}) + "\n")
        return
    if _OUTPUT_SHAPE == "claude":
        payload = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message,
            }
        }
        sys.stdout.write(json.dumps(payload) + "\n")
        return
    payload = {
        "permission": "deny",
        "user_message": message,
        "agent_message": message,
    }
    sys.stdout.write(json.dumps(payload) + "\n")


def load_locks():
    if not LOCK_FILE.is_file():
        return []
    lines = []
    for raw in LOCK_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip().replace("\\", "/")
        if not line or line.startswith("#"):
            continue
        while line.startswith("./"):
            line = line[2:]
        lines.append(line)
    return lines


def _load_path_policy() -> dict:
    """The effective path policy: consumer `paths`, else the pack's generated default.

    Read from `.harness/decision-policy.json` first — that file is already shared by the JS hooks and
    these Python guards, so it is the one place a consumer declares its own paths. When `paths` is
    absent the pack's `path-policy.default.json` is used, which the build generates from
    `path-policy.mjs`; that keeps a single hand-maintained list instead of a Python copy.

    Resolution rule: a declared list **replaces** the default rather than merging. Merging would
    resurrect a default the consumer removed — `sdlc/` being precisely that case.
    """
    keys = ("locked", "gated", "ask", "sot")
    policy_path = ROOT / ".harness" / "decision-policy.json"
    default_path = ROOT / ".harness" / "host-pack" / "path-policy.default.json"

    default = {k: [] for k in keys}
    try:
        raw = json.loads(default_path.read_text(encoding="utf-8"))
        for k in keys:
            if isinstance(raw.get(k), list):
                default[k] = [str(x) for x in raw[k] if str(x).strip()]
    except (OSError, json.JSONDecodeError):
        # No default available. Protection still resolves from the consumer policy below; if that is
        # missing too, `path_mode` fails closed and says so rather than silently protecting nothing.
        pass

    try:
        declared = json.loads(policy_path.read_text(encoding="utf-8")).get("paths")
    except (OSError, json.JSONDecodeError):
        declared = None

    out = {}
    for k in keys:
        value = declared.get(k) if isinstance(declared, dict) else None
        out[k] = [str(x) for x in value if str(x).strip()] if isinstance(value, list) else list(default[k])
    out["declared"] = isinstance(declared, dict)
    out["resolved"] = bool(out["declared"] or any(out[k] for k in keys))
    return out


PATH_POLICY = _load_path_policy()

# Kept as names because `guard-shell.py` imports them. `PROTECTED_EXACT` has no separate source any
# more: exact files are ordinary entries in `gated`, matched by equality rather than by prefix.
PROTECTED_PREFIXES = tuple(PATH_POLICY["gated"] + PATH_POLICY["ask"] + PATH_POLICY["locked"])
PROTECTED_EXACT = frozenset()


def entry_matches(rel: str, entry: str) -> bool:
    """Does one policy entry cover a path? Three shapes, by the entry itself.

    | entry | means | matches |
    |---|---|---|
    | `frontend/` | a directory | the directory itself, and everything below it |
    | `backend/mu-*` | a name prefix | `backend/mu-fusion`, `backend/mu-infra-lib`, ... |
    | `AGENTS.md` | one file | exactly that path, never a sibling like `AGENTS.md.bak` |

    The three shapes exist because the original code kept them in **two** lists — `PROTECTED_PREFIXES`
    matched with `startswith`, `PROTECTED_EXACT` with equality — and collapsing them into one list lost the
    distinction. The visible consequence was `backend/mu-`: as a prefix it gated every `mu-*` service, and
    as a non-directory entry under the new rule it matched nothing at all, so all backend code became
    writable without a gate. The `*` suffix makes the intent explicit rather than inferable.

    Equality is not simply relaxed to `startswith` for the no-suffix case: the root playbook files are exact
    on purpose, so drafts and `.bak` copies stay writable for a cleanup script to remove.
    """
    if not rel or not entry:
        return False
    if entry.endswith("/"):
        return rel == entry[:-1] or rel.startswith(entry)
    if entry.endswith("*"):
        return rel.startswith(entry[:-1])
    return rel == entry


def path_mode(rel: str) -> str:
    """`locked` / `ask` / `gated` / `""` for one repo-relative path.

    Most restrictive first, so a path listed twice cannot be loosened by the second entry. Fails
    **closed** when no policy could be resolved at all: an unreadable policy must not mean "nothing is
    protected".
    """
    if not PATH_POLICY["resolved"]:
        return "locked"
    for mode in ("locked", "ask", "gated"):
        for entry in PATH_POLICY[mode]:
            if entry_matches(rel, entry):
                return mode
    return ""


def project_id() -> str:
    """The consumer's project id, from `harness.config.json`. Empty when unreadable."""
    try:
        cfg = json.loads((ROOT / "harness.config.json").read_text(encoding="utf-8"))
        return str(cfg.get("project", {}).get("id") or "")
    except (OSError, json.JSONDecodeError):
        return ""


def product_state_dir() -> Path:
    """Product state (`~/.harness`), where consent records live.

    Mirrors `productStateDir()` in the product. Duplicated because this hook cannot import it; the env
    var is the same one the product reads, so an operator override cannot desynchronise the two.
    """
    override = os.environ.get("HARNESS_PRODUCT_STATE_DIR", "").strip()
    return Path(override) if override else Path.home() / ".harness"


def in_product_state(rel_or_abs: str) -> bool:
    """Is this target inside product state?

    Product state holds the project registry, the per-project databases and the consent records. It is
    not a place an agent writes: it is the operator's state, and it is the one directory whose integrity
    the agent's own gates depend on — a consent file the agent could rewrite would make the `ask` tier
    decorative, which is exactly how the previous session-dir waiver failed.
    """
    state = str(product_state_dir())
    text = str(rel_or_abs).replace("\\", "/")
    return text == state or text.startswith(state + "/")


def consent_covers(rel: str) -> bool:
    """Does a live, human-issued consent record cover this path?

    Read from `<product state>/consent/<projectId>.json`, written only by the console. Absent, expired or
    unreadable all mean "not covered" — the only safe direction, since the alternative is that a missing
    file reads as permission.
    """
    pid = project_id()
    if not pid:
        return False
    try:
        store = json.loads((product_state_dir() / "consent" / f"{pid}.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    now = datetime.now(timezone.utc)
    for record in store.get("records") or []:
        entry = str(record.get("path") or "").strip()
        if not entry:
            continue
        try:
            expires = datetime.fromisoformat(str(record.get("expiresAt") or ""))
        except ValueError:
            continue
        if expires <= now:
            continue
        if entry.endswith("/"):
            if rel == entry[:-1] or rel.startswith(entry):
                return True
        elif rel == entry:
            return True
    return False


def relativize(path: str) -> str:
    text = path.replace("\\", "/").strip()
    if not text:
        return ""
    marker = "/x79/"
    if marker in text:
        text = text.split(marker, 1)[1]
    try:
        resolved = Path(text)
        if resolved.is_absolute():
            text = str(resolved.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        pass
    # Collapse `.` / `..` BEFORE the prefix checks. Without this,
    # `.agents/x/../rules/y.md` does not start with `.agents/rules/` and would
    # slip past the Antigravity law-tree protection added above.
    text = os.path.normpath(text).replace("\\", "/")
    if text in (".", ""):
        return ""
    while text.startswith("./"):
        text = text[2:]
    return text


def locked(rel: str, locks: list[str]) -> bool:
    for prefix in locks:
        if prefix.endswith("/"):
            if rel == prefix[:-1] or rel.startswith(prefix):
                return True
        elif rel == prefix:
            return True
    return False


def secret_file(rel: str) -> bool:
    name = Path(rel).name
    if name in SECRET_NAMES or name.startswith(".env"):
        return True
    return name.endswith(SECRET_SUFFIXES)


def hook_exempt(rel: str) -> bool:
    if rel in (STAMP_REL, BRAIN_UNAVAILABLE_REL):
        return True
    return any(rel.startswith(p) for p in HOOK_EXEMPT_PREFIXES)


def requires_brain_stamp(rel: str) -> bool:
    # `ask` deliberately follows the same path as `gated` for now. Cursor's hook contract accepts
    # only `allow` and `deny` (measured from the shipped bundle: "'ask' permission … is not yet
    # implemented"), so a hook cannot prompt. Enforcing `ask` as a hard deny would be *stricter*
    # than before while telling the agent to wait for a consent channel that does not exist — a
    # brick, not a gate. The tier is recorded in policy so the intent is visible, and it becomes a
    # distinct behaviour once a human-only consent record exists.
    return path_mode(rel) in ("gated", "ask")

def asks_human(rel: str) -> bool:
    return path_mode(rel) == "ask"


# Cached because a hook process is short-lived but this is called on every gated write.
_STAMP_EXEMPT_CACHE = None


def stamp_write_exempt(rel: str) -> bool:
    """May the agent write the Brain stamp without an approval prompt? Opt-in, off by default.

    The stamp is in the session dir, which `hook_exempt()` already exempts — so the gate never asked about
    it. What the agent still hit was the **host's own** permission prompt (Cursor / Antigravity ask before
    a Write lands on a dotfile they did not see it create). This switch does not change the gate; it marks
    the file as "the harness owns this, do not prompt", and a consumer that sets it is saying so out loud.

    Why opt-in rather than on by default: the stamp is the *legacy* Brain evidence, and `brain_attested_legacy`
    believes it. An agent that can write it unattended can satisfy the fallback path with no model call —
    exactly the incident §6.3 records, where an agent overwrote `allowWrite` in a neighbouring stamp. On a
    tree whose guard reads the DeepSeek ledger first (Cursor, Antigravity, and DSH once
    `HARNESS_SESSION_DIR` is set) this costs nothing, because the ledger still decides. On a tree that
    relies on the stamp, it is a real relaxation — which is why it is a declaration in
    `.harness/decision-policy.json` and not a default:

        "eso": { "cognition": { "stampWrites": "exempt" } }

    Env `HARNESS_STAMP_WRITES=exempt` overrides for one session. Any other value keeps the prompt.
    """
    global _STAMP_EXEMPT_CACHE
    if _STAMP_EXEMPT_CACHE is not None:
        return _STAMP_EXEMPT_CACHE
    norm = str(rel or "").replace("\\", "/")
    while norm.startswith("./"):
        norm = norm[2:]
    if norm not in (STAMP_REL, BRAIN_UNAVAILABLE_REL, STAMP_NAME, BRAIN_UNAVAILABLE_NAME):
        if not norm.endswith("/" + STAMP_NAME) and not norm.endswith("/" + BRAIN_UNAVAILABLE_NAME):
            _STAMP_EXEMPT_CACHE = False
            return False

    env_val = os.environ.get("HARNESS_STAMP_WRITES", "").strip().lower()
    if env_val:
        _STAMP_EXEMPT_CACHE = env_val in ("exempt", "allow", "1", "true", "yes", "on")
        return _STAMP_EXEMPT_CACHE
    try:
        raw = json.loads((ROOT / ".harness" / "decision-policy.json").read_text(encoding="utf-8"))
        cog = (raw.get("eso") or {}).get("cognition") if isinstance(raw.get("eso"), dict) else None
        value = str((cog or {}).get("stampWrites") or "").strip().lower()
        _STAMP_EXEMPT_CACHE = value in ("exempt", "allow")
    except (OSError, json.JSONDecodeError, AttributeError):
        _STAMP_EXEMPT_CACHE = False
    return _STAMP_EXEMPT_CACHE


def stamp_write_marker(rel: str) -> None:
    """Say "the harness owns this file" when the consumer opted in, then allow.

    Cursor's `PreToolUse` contract accepts `permission: "allow"`, and an explicit allow is how a hook tells
    the host not to prompt for a file it is responsible for. Without the opt-in this prints the same allow
    the guard would print anyway, so the host's prompt behaviour is unchanged for every other consumer —
    including for the stamp, which was already exempt from the gate and only ever prompted at the host.
    """
    if stamp_write_exempt(rel):
        allow()
        return
    allow()


def parse_stamp_at(raw: str) -> datetime | None:
    if not raw:
        return None
    text = str(raw).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


_ALLOW_FALLBACK_CACHE = None


def allow_session_stamp_fallback() -> bool:
    """Whether to fall back to legacy agent-writable session stamps when product-state attestation is absent.

    Defaults to True for backward-compatibility during rollout (Issue #7). Can be disabled
    via `.harness/decision-policy.json` (`allowSessionStampFallback: false`) or env var
    `HARNESS_ALLOW_SESSION_STAMP_FALLBACK=0/false`.
    """
    global _ALLOW_FALLBACK_CACHE
    if _ALLOW_FALLBACK_CACHE is not None:
        return _ALLOW_FALLBACK_CACHE

    env_val = os.environ.get("HARNESS_ALLOW_SESSION_STAMP_FALLBACK", "").strip().lower()
    if env_val in ("0", "false", "no", "off"):
        _ALLOW_FALLBACK_CACHE = False
        return False
    if env_val in ("1", "true", "yes", "on"):
        _ALLOW_FALLBACK_CACHE = True
        return True

    policy_path = ROOT / ".harness" / "decision-policy.json"
    try:
        raw = json.loads(policy_path.read_text(encoding="utf-8"))
        if "allowSessionStampFallback" in raw:
            _ALLOW_FALLBACK_CACHE = bool(raw["allowSessionStampFallback"])
            return _ALLOW_FALLBACK_CACHE
        eso_cfg = raw.get("eso")
        if isinstance(eso_cfg, dict) and "allowSessionStampFallback" in eso_cfg:
            _ALLOW_FALLBACK_CACHE = bool(eso_cfg["allowSessionStampFallback"])
            return _ALLOW_FALLBACK_CACHE
        sec_cfg = raw.get("security")
        if isinstance(sec_cfg, dict) and "allowSessionStampFallback" in sec_cfg:
            _ALLOW_FALLBACK_CACHE = bool(sec_cfg["allowSessionStampFallback"])
            return _ALLOW_FALLBACK_CACHE
    except (OSError, json.JSONDecodeError):
        pass

    _ALLOW_FALLBACK_CACHE = True
    return True


def _defer_norm(p) -> str:
    s = str(p or "").strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return s


def deferred_evidence_path(defer_write, rel: str, raw: str) -> bool:
    """Does this write land under `eso.preflight.deferWrite.paths` (§G-20)?

    Same normalisation and the same segment boundary as `isDeferredWritePath` in `gate.mjs`: the guard
    and the verdict must not disagree about *which file* a path names. `SDLC` covers `SDLC/x.md` and
    not `SDLCX/x.md`.

    Deferral replaces **nothing**: the caller still reached this point through the `locked` tier, the
    secret scan and the Brain stamp, and the same `target_path()` hit means the shell guard will make
    the same decision for `echo > file`. Only the sufficiency verdict stops holding the write.
    """
    if not isinstance(defer_write, dict):
        return False
    paths = defer_write.get("paths")
    if not isinstance(paths, list) or not paths:
        return False
    candidates = []
    for value in (rel, raw):
        n = _defer_norm(value)
        if n and n not in candidates:
            candidates.append(n)
    for value in candidates:
        for item in paths:
            prefix = _defer_norm(item).rstrip("/")
            if not prefix:
                continue
            if value == prefix or value.startswith(prefix + "/"):
                return True
    return False


def _stat_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def current_repo_state() -> dict:
    """The tree as it is now, in the two facts the receipt recorded (`computeRepoState`)."""
    return {
        "indexMtime": _stat_mtime(ROOT / ".git" / "index"),
        "policyMtime": max(
            _stat_mtime(ROOT / ".harness" / "decision-policy.json"),
            _stat_mtime(ROOT / "harness.config.json"),
        ),
    }


def repo_state_changed(recorded) -> bool:
    """Has the working tree moved since this receipt was minted? (§G-21)

    Compares only values present on **both** sides: a receipt from an older pack, or a tree with no
    `.git`, recorded nothing, and reading "unknown" as "changed" would refuse every write in exactly the
    consumers this check was added for. Tolerance is 2s because `mtime` is a filesystem timestamp and a
    write in the same second as the mint is the normal case, not a change worth refusing.
    """
    if not isinstance(recorded, dict):
        return False
    now = current_repo_state()
    for key in ("indexMtime", "policyMtime"):
        try:
            before = float(recorded.get(key) or 0)
        except (TypeError, ValueError):
            continue
        after = float(now.get(key) or 0)
        if before > 0 and after > 0 and abs(after - before) > 2.0:
            return True
    return False


def eso_verdict() -> dict:
    """The evidence verdict this write is judged by, and why the gate refused (§G-12/G-08).

    `eso_fail_closed_blocks` returns a bool, and a bool cannot explain itself. atrievefin's operator was
    told to "set eso.mode=hint/observe" while the guard was reading `enforceWrites: fail_closed` — a key
    their policy file does not contain — and that gate had already exempted the one gap it could not
    close (§G-02). Both are facts in the stamp; neither reached the message. So the reader is split out:

      `gate`   — `fail_closed` | `off` | `unknown` (from `mode` / `enforceWrites`)
      `reasons`— why this write is blocked: `unattributable` (MAC tampered), `repo_changed` (the tree
                 moved since the verdict), `level` (evidence)
      `unanswerable` — gap ids the preflight named as closable by nothing
      `source` — `attestation` (product state) or `session` (legacy fallback)
      `defaulted` — `enforceWrites` was supplied by the strict default, not written by the consumer
      `jevOnPartial` — this consumer publishes nothing on `partial`, however many gaps are closed
      `deferWrite` — `eso.preflight.deferWrite`: paths whose evidence is deferred, not their protection

    Empty dict when no verdict exists at all (a consumer whose pack has not been refreshed).
    """
    data = eso_attestation()
    source = "attestation"
    if not data and allow_session_stamp_fallback():
        data = session_stamp()
        source = "session"
    if not data:
        return {}

    mode = data.get("mode")
    enforce_writes = data.get("enforceWrites")
    # Promax: eso.mode hint + enforceWrites fail_closed (stamp may keep mode=hint).
    gate = "fail_closed" if mode == "fail_closed" or enforce_writes == "fail_closed" else (
        "off" if mode or enforce_writes else "unknown"
    )
    level = data.get("level") or ""
    unanswerable = [str(g.get("id")) for g in (data.get("unanswerableGaps") or []) if isinstance(g, dict) and g.get("id")]
    result = {
        "gate": gate,
        "level": level,
        "source": source,
        "unanswerable": unanswerable,
        "reasons": [],
        # The pack records whether the consumer wrote the key (`enforceWritesSource: default`); an absent
        # field means the stamp predates that disclosure, so nothing is claimed about it.
        "defaulted": data.get("enforceWritesSource") == "default",
        # On `partial` alone this consumer publishes nothing (`gate.mjs`), so "close the remaining gaps"
        # would be advice that cannot work. One bool, read from the same verdict the gate read.
        "jevOnPartial": data.get("jevOnPartial") is True,
        # `eso.preflight.deferWrite` (G-20): paths whose *evidence* is deferred. Carried even when the
        # gate is open, because the message may need to say why a `gated` path was writable.
        "deferWrite": data.get("deferWrite") if isinstance(data.get("deferWrite"), dict) else {},
    }
    if gate != "fail_closed":
        return result
    if data.get("allowWrite") is True:
        # P2: State Hardening — Verify HMAC and did-the-tree-change on Product State Receipt.
        #
        # Age is deliberately not checked (G-21). A verdict about a tree nobody has written to is still
        # true an hour later; one about a tree that has been rewritten is false immediately. `repoState`
        # (git index mtime, policy mtime) answers the second question; `ttlSec` only answered "how long
        # since we last asked", and refusing an idle agent was the whole cost of that substitution.
        if data.get("mac"):
            secret = get_attest_secret(project_id())
            if not verify_receipt_mac(data, secret):
                result["reasons"] = ["unattributable"]
                return result
            if repo_state_changed(data.get("repoState")):
                result["reasons"] = ["repo_changed"]
                return result
        return result
    closure = _read_json(session_path(".eso-gap-closure.json"))
    if closure.get("allClosed") is True and (not data.get("preflightAt") or closure.get("preflightAt") == data.get("preflightAt")):
        return result
    if level in ("insufficient", "partial"):
        result["reasons"] = ["level"]
    return result


def eso_fail_closed_blocks() -> bool:
    """Does the evidence gate block this write?

    Prefers the product-state attestation the pack's preflight hook wrote; falls back to the session
    stamp when no attestation exists AND fallback is enabled (a consumer whose pack has not been
    refreshed). The two carry the same fields, so the decision logic in `eso_verdict` is shared rather
    than duplicated — a second copy of "what does fail_closed mean" is how the guard and the pack would
    come to disagree.
    """
    verdict = eso_verdict()
    return bool(verdict) and verdict.get("gate") == "fail_closed" and bool(verdict.get("reasons"))


def get_attest_secret(pid: str) -> str:
    env_sec = os.environ.get("HARNESS_ATTEST_SECRET", "").strip()
    if env_sec:
        return env_sec
    secret_path = product_state_dir() / ".attest_secret"
    try:
        if secret_path.is_file():
            sec = secret_path.read_text(encoding="utf-8").strip()
            if sec:
                return sec
    except Exception:
        pass
    return hashlib.sha256(f"harness-eso:{pid or 'default'}".encode("utf-8")).hexdigest()


def verify_receipt_mac(doc: dict, secret: str) -> bool:
    mac = str(doc.get("mac") or "").strip()
    if not mac:
        return False
    inv_ids = doc.get("invIds") or []
    if isinstance(inv_ids, list):
        inv_str = ",".join(str(x) for x in inv_ids)
    else:
        inv_str = ""
    score = float(doc.get("score") if doc.get("score") is not None else 0.0)
    ttl = int(doc.get("ttlSec") or 600)
    data = "|".join([
        str(doc.get("projectId") or ""),
        str(doc.get("at") or ""),
        str(doc.get("fingerprint") or ""),
        inv_str,
        str(bool(doc.get("allowWrite"))).lower(),
        str(doc.get("level") or ""),
        f"{score:.2f}",
        str(ttl),
    ])
    expected = hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, expected)


def direct_mode_on() -> bool:
    """True when {DIRECT_MODE_REL} exists and is enabled (ON)."""
    sentinel_path = DIRECT_MODE_PATH
    if not sentinel_path.is_file():
        return False
    try:
        raw = sentinel_path.read_text(encoding="utf-8").strip()
        if not raw:
            return True  # Empty file fallback (touch)
        if raw.startswith("{"):
            cfg = json.loads(raw)
            return bool(cfg.get("enabled", False) or str(cfg.get("mode", "")).lower() in ("on", "direct", "true", "enabled"))
        return raw.lower() in ("on", "true", "1", "direct", "enabled")
    except Exception:
        return False


def _read_json(path_obj) -> dict:
    try:
        return json.loads(path_obj.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def eso_attestation() -> dict:
    """The pack's evidence verdict, from product state.

    Written by the pack's preflight hook — a hook, not a tool call — into a directory both guards deny
    writes to. The guard prefers it over the session stamp because the session stamp sits next to the
    Brain stamp, which the agent must be able to write, and an incident had the agent overwrite
    `allowWrite` there and invent a score.

    Empty when absent, which includes a consumer whose pack has not been refreshed. The caller then falls
    back to the session stamp, preserving the previous behaviour rather than failing closed on a
    deployment that has not migrated.
    """
    pid = project_id()
    if not pid:
        return {}
    return _read_json(product_state_dir() / "attest" / f"{pid}.json")


def session_stamp() -> dict:
    """The legacy session-dir stamp. Kept as the fallback path — see `eso_attestation`."""
    return _read_json(session_path(ESO_STAMP_NAME))


def brain_attested() -> dict:
    """Did a Brain-tier model call complete recently?

    Read from the DeepSeek MCP server's usage ledger in product state — the only record of a model call
    that actually finished. The old check read `.pipeline-brain-stamp.json`, which the rules instruct the
    agent to write **itself**, so it attested nothing.

    LIMITATION, stated rather than hidden: the ledger is machine-wide, because an MCP server is handed a
    prompt and nothing else — no conversation, no generation. So this attests "a Brain call completed
    nearby", not "for this turn". A Brain call in another project could satisfy a gate here. The accurate
    per-turn join (`sha256(prompt)` between transcript and ledger) lives in the observer and is not
    reachable at gate time.
    """
    override = os.environ.get("DEEPSEEK_USAGE_LEDGER", "").strip()
    path_obj = Path(override) if override else (product_state_dir() / "deepseek-usage.jsonl")
    try:
        size = path_obj.stat().st_size
        start = max(0, size - 64 * 1024)
        with path_obj.open("rb") as fh:
            fh.seek(start)
            text = fh.read().decode("utf-8", "replace")
    except OSError:
        return {}
    now = datetime.now(timezone.utc)
    newest = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            # The first line of a tail read is normally a fragment.
            continue
        if str(rec.get("role") or "") not in ("pro", "brain_flash", "brain_fallback"):
            continue
        try:
            at = datetime.fromisoformat(str(rec.get("at") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if newest is None or at > newest:
            newest = at
    if newest is None:
        return {}
    age = (now - newest).total_seconds()
    # A timestamp from the future means a clock problem; refusing is safer than treating it as fresh.
    if age < -120 or age > STAMP_MAX_AGE_SECONDS:
        return {}
    return {"ok": True, "at": newest.isoformat()}


def brain_session_stamp() -> dict:
    """The pipeline-brain stamp recording recent model/direct calls."""
    return _read_json(STAMP_PATH)


def brain_attested_legacy() -> bool:
    """The session-stamp check, kept as the fallback while a consumer migrates to attestations."""
    data = brain_session_stamp()
    if not data.get("ok"):
        data = session_stamp()
    if not data.get("ok"):
        return False
    via = data.get("via")
    if via not in BRAIN_VIA:
        return False
    at = parse_stamp_at(data.get("at", ""))
    if at is None:
        return False
    age = (datetime.now(timezone.utc) - at).total_seconds()
    if age < -120 or age > STAMP_MAX_AGE_SECONDS:
        return False
    # Branch A — Direct mode ON (sentinel exists)
    if direct_mode_on() and via == "direct_ide":
        if data.get("brainTier") != "direct_ide":
            return False
        return data.get("directMode") is True
    # Branch B — Default fail-closed: direct_ide rejected
    if via == "direct_ide":
        return False
    return True


def brain_from_attestation() -> dict:
    """Brain evidence a host recorded by witnessing the model call, if any.

    A host with no command-hook mechanism (DSH) runs this gate from a plugin, and its sandbox gives the
    MCP child no way to write the usage ledger — so on that host the ledger path is dead by construction,
    and pointing it somewhere the child *can* write would put forgeable evidence in the agent's reach.

    Such a host records the call itself instead: `brain` in the product-state attestation, written from a
    host pipeline listener (`tools/post-execute`) that fires only for a non-error result. Same file the
    evidence gate already reads, so there is no second document to keep in step.
    """
    data = eso_attestation()
    brain = data.get("brain") if isinstance(data, dict) else None
    if not isinstance(brain, dict) or not brain.get("ok") or not brain.get("at"):
        return {}
    try:
        at = datetime.fromisoformat(str(brain.get("at")).replace("Z", "+00:00"))
    except ValueError:
        return {}
    age = (datetime.now(timezone.utc) - at).total_seconds()
    # Same window and same future-timestamp refusal as the ledger: two sources for one gate must not
    # disagree about what "recent" means.
    if age < -120 or age > STAMP_MAX_AGE_SECONDS:
        return {}
    return {"ok": True, "at": at.isoformat(), "via": str(brain.get("via") or "attestation")}


def brain_stamp_valid() -> bool:
    """Brain gate: host-witnessed call first, then the ledger, then the stamp if the consumer allows it.

    Order matters and is not alphabetical: an attestation is a *this-session* observation, the ledger is
    machine-wide, and the stamp is agent-writable. Preferring the tightest source means a stale ledger row
    from another project can no longer satisfy a gate here.
    """
    if brain_from_attestation().get("ok"):
        return True
    if brain_attested().get("ok"):
        return True
    if allow_session_stamp_fallback():
        return brain_attested_legacy()
    return False


def main() -> int:
    global _OUTPUT_SHAPE
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        deny("Hook input invalid (fail-closed). Retry or fix Cursor hook payload.")
        return 0

    _OUTPUT_SHAPE = detect_shape(data)
    tool_input = extract_tool_input(data)
    if not isinstance(tool_input, dict):
        allow()
        return 0

    path = (
        tool_input.get("path")
        or tool_input.get("file_path")
        or tool_input.get("target_file")
        or ""
    )
    contents = (
        tool_input.get("contents")
        or tool_input.get("new_string")
        or tool_input.get("content")
        or ""
    )
    raw_path = str(path or "").replace("\\", "/").strip()
    rel = relativize(raw_path)
    if not rel:
        allow()
        return 0

    locks = load_locks()
    # Checked against the RAW path, not `rel`. `relativize` strips everything before a `/x79/` marker
    # (a consumer-specific convenience), so `~/.harness/observe/x79/harness.db` comes back as
    # `harness.db` — a name that matches nothing and would walk straight into product state.
    if in_product_state(raw_path) or in_product_state(rel):
        deny(
            "Product state is not agent-writable: "
            + rel
            + ". It holds the project registry, the observe databases and the consent records — "
            "the last of which the agent's own gates depend on."
        )
        return 0
    if locked(rel, locks) or path_mode(rel) == "locked":
        deny(f"Locked path: {rel}. This path is not agent-writable.")
        return 0
    if secret_file(rel):
        deny(f"Secret file write blocked: {rel}.")
        return 0
    sample = str(contents)[:200_000]
    if sample and (PRIVATE_KEY.search(sample) or AWS_KEY.search(sample)):
        deny(f"Secret material blocked in write to {rel}.")
        return 0

    if not hook_exempt(rel) and requires_brain_stamp(rel):
        verdict = eso_verdict()
        # §G-20: on a `deferWrite` path the sufficiency verdict does not hold the write; every other
        # condition that got us here (locked, product state, secrets) still did. The Brain stamp below
        # has never been about evidence and is not exempted — deferring evidence must not also defer
        # "reason before you write".
        if eso_fail_closed_blocks() and not deferred_evidence_path(verdict.get("deferWrite"), rel, raw_path):
            deny(deny_eso_message())
            return 0
        if not brain_stamp_valid():
            deny(deny_brain_message())
            return 0

    # `ask` — a human decision, recorded outside the repo. Checked after the evidence gates: satisfying
    # them does not substitute for consent, because the two answer different questions ("is there enough
    # context?" vs "is this the agent's to decide?").
    if asks_human(rel) and not consent_covers(rel):
        deny(
            f"Human consent required for {rel}. Approve it in Harness Console "
            f"(POST /api/projects/{project_id()}/consent) — an agent cannot grant this."
        )
        return 0

    stamp_write_marker(rel)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        deny(f"Hook error (fail-closed): {exc}")
        raise SystemExit(0)
