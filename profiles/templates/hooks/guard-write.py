#!/usr/bin/env python3
"""Deny agent writes to mu bible law, secrets, and paths without Brain stamp."""

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
SESSION_REL = f"{HARNESS_DIR}/session"

STAMP_REL = f"{SESSION_REL}/.pipeline-brain-stamp.json"
ESO_STAMP_NAME = ".eso-bundle-stamp.json"
BRAIN_UNAVAILABLE_REL = f"{SESSION_REL}/.brain-unavailable.json"
DIRECT_MODE_REL = f"{SESSION_REL}/.direct-mode"
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

DENY_BRAIN = (
    "Brain gate (fail-closed): protected path requires DeepSeek Brain first. "
    "Call ask_deepseek_pro (or [BRAIN FALLBACK] ask_deepseek_flash), then write "
    f"{STAMP_REL}. "
    "If MCP is down, write "
    f"{BRAIN_UNAVAILABLE_REL} "
    "and tell the user BRAIN_UNAVAILABLE — do not bypass silently."
)

_OUTPUT_SHAPE = "cursor"


def detect_shape(data: dict) -> str:
    if not isinstance(data, dict):
        return "cursor"
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
            if val.get("path") or val.get("file_path") or val.get("target_file"):
                return val
    call = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    path = ""
    for pk in ("path", "file_path", "target_file", "AbsolutePath", "TargetFile"):
        if isinstance(args.get(pk), str) and args[pk]:
            path = args[pk]
            break
    contents = ""
    for ck in ("contents", "new_string", "content", "NewContent", "text", "body"):
        if ck in args and args[ck] is not None:
            contents = args[ck]
            break
    if path or contents:
        return {"path": path, "contents": contents}
    return {}


def allow():
    if _OUTPUT_SHAPE == "antigravity":
        sys.stdout.write('{"decision":"allow"}\n')
    else:
        sys.stdout.write('{"permission":"allow"}\n')


def deny(message: str):
    if _OUTPUT_SHAPE == "antigravity":
        sys.stdout.write(json.dumps({"decision": "deny", "reason": message}) + "\n")
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


def eso_fail_closed_blocks() -> bool:
    """Does the evidence gate block this write?

    Prefers the product-state attestation the pack's preflight hook wrote; falls back to the session
    stamp when no attestation exists AND fallback is enabled (a consumer whose pack has not been
    refreshed). The two carry the same fields, so the decision logic below is shared rather than
    duplicated — a second copy of "what does fail_closed mean" is how the guard and the pack would come to
    disagree.
    """
    data = eso_attestation()
    if not data and allow_session_stamp_fallback():
        data = session_stamp()
    if not data:
        return False
    mode = data.get("mode")
    enforce_writes = data.get("enforceWrites")
    # Promax: eso.mode hint + enforceWrites fail_closed (stamp may keep mode=hint).
    if mode != "fail_closed" and enforce_writes != "fail_closed":
        return False
    if data.get("allowWrite") is True:
        return False
    level = data.get("level") or ""
    return level in ("insufficient", "partial")


def direct_mode_on() -> bool:
    """True when .{SESSION_REL}/.direct-mode exists and is enabled (ON)."""
    sentinel_path = ROOT / DIRECT_MODE_REL
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
    return _read_json(ROOT / SESSION_REL / ESO_STAMP_NAME)


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


def brain_attested_legacy() -> bool:
    """The session-stamp check, kept as the fallback while a consumer migrates to attestations."""
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


def brain_stamp_valid() -> bool:
    """Brain gate: the ledger first, the session stamp only as a fallback if enabled."""
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
    if locked(rel, locks):
        deny(f"Locked path: {rel}. document/mu/be/00.law is not agent-writable.")
        return 0
    if secret_file(rel):
        deny(f"Secret file write blocked: {rel}.")
        return 0
    sample = str(contents)[:200_000]
    if sample and (PRIVATE_KEY.search(sample) or AWS_KEY.search(sample)):
        deny(f"Secret material blocked in write to {rel}.")
        return 0

    if not hook_exempt(rel) and requires_brain_stamp(rel):
        if eso_fail_closed_blocks():
            deny(DENY_ESO)
            return 0
        if not brain_stamp_valid():
            deny(DENY_BRAIN)
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

    allow()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        deny(f"Hook error (fail-closed): {exc}")
        raise SystemExit(0)
