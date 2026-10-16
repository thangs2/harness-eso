#!/usr/bin/env python3
"""x79 harness route tracer — observability only, never blocks.

Wired from `.cursor/hooks.json` / `.agents/hooks.json` on OBSERVATIONAL events
only. It is deliberately NOT attached to `preToolUse`: that event carries the
write guard's deny decision, and a second hook answering there could mask a deny.

Appends one compact JSON line per event to
    <repo>/{.cursor,.agents}/session/route-trace.jsonl

Note `--harness cursor` is an ID, not a path segment: it resolves to the
`.cursor/` tree via `TREE_DIR`. Passing the id straight into a path is what
once produced a stray top-level `cursor/` folder.

THE HARNESS IS AN EXPLICIT INPUT — never derived from this file's location.
While this file lived at `<harness>/hooks/route-hook.py`, guessing
`parents[1].name` happened to be correct. Once it moved to `scripts/route/`,
that same guess resolved to `scripts`, so every event landed in
`scripts/session/route-trace.jsonl` — a path nothing reads — and the route
explorer reported "no trace recorded yet" while 181 real events sat on disk.
It has since moved twice more, to `tools/monitors/harness/` and then to its
`src/` — each move a level deeper — and the root is still found by walking up
from `cwd` to the ancestor holding the tree, so the extra depth changes nothing.
An identity inferred from where a file happens to sit breaks silently on the next
move; pass it in instead (`--harness`, or `ROUTE_HARNESS`).

Fails open: any error still prints `{"permission":"allow"}` so a broken tracer
can never stop a session.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

SHELL_TOOL_RE = re.compile(
    r"shell|terminal|bash|run_command|run_terminal|execute",
    re.I,
)

MAX_STR = 400
DROP_KEYS = {"contents", "content", "new_string", "old_string", "text", "code"}
# The producer list is DATA, not code. It used to be hardcoded here — and again in
# `db/migrations/001_init.sql` (CHECK), in `lib/ingest-hooks.mjs`, and in
# `pre-compact-checkpoint.py` — so a THIRD IDE could not be recorded without editing
# all four, and a second one could not be recorded at all until every layer agreed.
# It now comes from `harness.config.json` § ingest.harnesses, which makes adding an
# IDE a config edit. This tuple is the fallback for a config that has not migrated
# yet, and the single place a default is written down.
DEFAULT_PRODUCERS = (
    {"id": "cursor", "tree": ".cursor", "shape": "cursor"},
    {"id": "agents", "tree": ".agents", "shape": "antigravity"},
)

_PRODUCERS = None


def producers():
    """Producer list from the repo config — lazy, cached, and defensive.

    Any failure (no config, bad JSON, odd shape) falls back to DEFAULT_PRODUCERS
    rather than raising. A tracer that cannot name its harness writes nothing at all,
    which is the exact failure mode this tool has already been burned by twice.
    """
    global _PRODUCERS
    if _PRODUCERS is not None:
        return _PRODUCERS
    raw = None
    try:
        _, cfg_path = find_config()
        if cfg_path is not None:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(cfg, dict):
                raw = (cfg.get("ingest") or {}).get("harnesses")
    except Exception:
        raw = None
    out = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item:
                out.append({"id": item, "tree": "." + item, "shape": item})
            elif isinstance(item, dict) and item.get("id"):
                hid = str(item["id"])
                out.append(
                    {
                        "id": hid,
                        "tree": str(item.get("tree") or ("." + hid)),
                        "shape": str(item.get("shape") or hid),
                    }
                )
    _PRODUCERS = out or list(DEFAULT_PRODUCERS)
    return _PRODUCERS


def harness_ids():
    return tuple(p["id"] for p in producers())


def tree_map():
    return {p["id"]: p["tree"] for p in producers()}


def shape_of(harness: str) -> str:
    for p in producers():
        if p["id"] == harness:
            return p["shape"]
    return harness

# The tenant config lives at the repo root and is the walk-up anchor for the
# whole tool (tracer, server, ingest). The tracer reads it for one reason only:
# to learn whether tracking is OFF, so it can get out of the way immediately.
CONFIG_NAME = "harness.config.json"
DEFAULT_SENTINEL = ".harness/DISABLED"


def norm_harness(value) -> str:
    """Accept an id, a tree dir (`.cursor`), or any case; return the canonical id or "".

    An id is NOT its directory name, so both spellings are accepted and resolved
    against the configured producers. Anything unknown returns "" — the caller then
    writes nothing rather than writing into a directory it invented.
    """
    v = str(value or "").strip().lower().lstrip(".")
    if not v:
        return ""
    for p in producers():
        if v == p["id"].lower() or v == str(p["tree"]).strip().lower().lstrip("."):
            return p["id"]
    return ""


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


SECRET_REDACT_PATTERNS = [
    (re.compile(r"(-u|--user)\s+(['\"]?[^:\s'\"]+:)([^'\"]+)(['\"]?)", re.I), r"\1 \2[REDACTED]\4"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-~+/]+=*", re.I), r"\1[REDACTED]"),
    (re.compile(r"(Basic\s+)[A-Za-z0-9+/=]{16,}", re.I), r"\1[REDACTED]"),
    (re.compile(r"\bATATT3[A-Za-z0-9_\-=]{20,}\b"), "[REDACTED_JIRA_TOKEN]"),
    (re.compile(r"(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|APIKEY)\b\s*[:=]\s*['\"]?)([^'\";\s&]+)(['\"]?)", re.I), r"\1[REDACTED]\3"),
    (re.compile(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----.*?-----END [A-Z ]+ PRIVATE KEY-----", re.S), "[REDACTED_PRIVATE_KEY]"),
]


def redact_sensitive(text: str) -> str:
    if not isinstance(text, str) or not text:
        return text
    res = text
    for pattern, repl in SECRET_REDACT_PATTERNS:
        res = pattern.sub(repl, res)
    return res


def scrub(value, depth=0):
    """Trim payload so a trace line stays small, never carries file bodies, and scrubs secrets."""
    if depth > 6:
        return "…"
    if isinstance(value, str):
        cleaned = redact_sensitive(value)
        if len(cleaned) > MAX_STR:
            return cleaned[:MAX_STR] + f"…(len={len(cleaned)})"
        return cleaned
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in DROP_KEYS:
                out[k] = {"_dropped": True, "len": len(v) if hasattr(v, "__len__") else None}
            else:
                out[k] = scrub(v, depth + 1)
        return out
    if isinstance(value, list):
        return [scrub(v, depth + 1) for v in value[:60]]
    return value


def parse_harness(argv) -> str:
    """Explicit harness id: `--harness <id>` beats `$ROUTE_HARNESS`.

    The id is validated against the CONFIGURED producers, not a hardcoded list.
    """
    for i, arg in enumerate(argv):
        if arg == "--harness" and i + 1 < len(argv):
            return norm_harness(argv[i + 1])
        if arg.startswith("--harness="):
            return norm_harness(arg.split("=", 1)[1])
    return norm_harness(os.environ.get("ROUTE_HARNESS", ""))


def discover_harness() -> str:
    """Last resort only — never based on this file's own location, which broke.

    A repo that contains BOTH `.cursor/` and `.agents/` cannot be guessed: picking
    one would attribute the other harness's events to the wrong tree. So this
    returns a harness only when the ancestor holds exactly one, and "" otherwise —
    the caller then writes nothing rather than writing somewhere wrong.
    """
    here = Path.cwd().resolve()
    trees = tree_map()
    for candidate in [here, *here.parents]:
        found = [h for h in harness_ids() if (candidate / trees[h]).is_dir()]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            return ""
    return ""


def trace_path(harness: str) -> Path:
    override = os.environ.get("ROUTE_TRACE")
    if override:
        return Path(override)
    tree = tree_map().get(harness, "." + harness)
    root = Path.cwd().resolve()
    for candidate in [root, *root.parents]:
        if (candidate / tree).is_dir():
            return candidate / tree / "session" / "route-trace.jsonl"
    return root / tree / "session" / "route-trace.jsonl"


def split_attachments(raw):
    """Cursor sends `attachments: [{type:"rule"|"file", file_path}]`.

    This is the only ground-truth record of WHICH rules were attached to a
    request — nowhere else in the trace or the transcript is it available. Keep
    the raw list and, for convenience, the two classes split out.
    """
    if not isinstance(raw, list):
        return [], [], []
    rules, files = [], []
    for item in raw:
        if not isinstance(item, dict):
            continue
        path = item.get("file_path") or item.get("path") or ""
        kind = str(item.get("type") or "").lower()
        if not path:
            continue
        if kind == "rule":
            rules.append(path)
        else:
            files.append(path)
    return raw, rules, files


# --- Antigravity adapter -----------------------------------------------------
# Antigravity's hook system is a different schema AND a different payload
# vocabulary than Cursor's (camelCase protojson: conversationId/workspacePaths/
# stepIdx/toolCall). Rather than teach every consumer about both, the payload is
# normalized here into the Cursor-shaped record, so the ingest layer stays
# harness-agnostic and needs no Antigravity branch.
#
# The event NAME is not in the payload — a PostToolUse payload is literally just
# `{stepIdx, error?, conversationId, …common}`. hooks.json therefore passes it in, and
# that is the only place it exists.
AGY_EVENTS = ("PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop")
AGY_EVENT_MAP = {
    "PreToolUse": "preToolUse",
    "PostToolUse": "postToolUse",
    "PreInvocation": "preInvocation",
    "PostInvocation": "postInvocation",
    "Stop": "stop",
}
AGY_CACHE_NAME = ".agy-tool-cache.json"
AGY_CACHE_MAX = 500

# A SHAPE is a payload vocabulary, independent of which producer sends it. Two
# different IDEs that happen to share a vocabulary share a shape — and therefore
# share the normalizer and the output contract below, with no new code.
CURSOR_SHAPE = "cursor"
ANTIGRAVITY_SHAPE = "antigravity"


def parse_event(argv) -> str:
    """The event name, for a producer whose payload does not carry one.

    `--event` is the generic spelling; `--agy-event` is kept as an alias because the
    first cut of this adapter used it. Unknown values are ignored rather than guessed.
    """
    for i, arg in enumerate(argv):
        if arg in ("--event", "--agy-event") and i + 1 < len(argv):
            value = argv[i + 1]
        elif arg.startswith("--event=") or arg.startswith("--agy-event="):
            value = arg.split("=", 1)[1]
        else:
            continue
        return value if value in AGY_EVENTS else ""
    return ""


def detect_shape(data) -> str:
    """Which vocabulary is this payload speaking?

    Detected from the PAYLOAD, not from a flag: a flag makes the caller the authority
    on its own identity, and that breaks the moment a hook is invoked by hand, proxied,
    or reused by a fork. Cursor always carries `hook_event_name`; Antigravity carries
    `conversationId` + `stepIdx` and never a `toolCall`-less shell step.
    """
    if not isinstance(data, dict):
        return ""
    if data.get("hook_event_name") or data.get("hookEventName"):
        return CURSOR_SHAPE
    if data.get("conversationId") and data.get("stepIdx") is not None:
        return ANTIGRAVITY_SHAPE
    if isinstance(data.get("toolCall"), dict):
        return ANTIGRAVITY_SHAPE
    return ""


def fast_shape(event_name: str) -> str:
    """Shape for the DISABLED fast path, where stdin is deliberately not parsed.

    The only signal left is whether `--event` was passed. Only a producer whose
    payload omits the event name passes it, and today that is Antigravity's
    vocabulary — Cursor always carries `hook_event_name` inside the payload.
    """
    return ANTIGRAVITY_SHAPE if event_name else CURSOR_SHAPE


def hook_response(shape: str, event: str) -> str:
    """Answer in the output contract the CALLING producer actually speaks.

    Cursor accepts `{"permission":"allow"}` on every event. Antigravity does not:
    `PreToolUse` REQUIRES `decision`, and the invocation events expect an object
    (optionally carrying `injectSteps`). Emitting Cursor's shape at an Antigravity
    hook leaves a REQUIRED field undefined, which is not a harmless no-op — the call
    risks being prompted or blocked. Keyed on SHAPE rather than on the harness id, so
    any producer that declares `shape: antigravity` — the CLI, a fork, a future IDE
    reusing the vocabulary — is covered without a code change.
    """
    if shape != ANTIGRAVITY_SHAPE:
        return '{"permission":"allow"}\n'
    if event == "PreToolUse":
        return '{"decision":"allow"}\n'
    if event in ("PreInvocation", "PostInvocation"):
        return '{"injectSteps":[]}\n'
    return "{}\n"


def agy_cache_path(trace: Path) -> Path:
    return trace.parent / AGY_CACHE_NAME


def load_agy_cache(trace: Path) -> dict:
    """Best-effort. A missing or corrupt cache just means no tool-name pairing."""
    try:
        obj = json.loads(agy_cache_path(trace).read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def save_agy_cache(trace: Path, cache: dict) -> None:
    """Atomic + bounded. Never raises: this runs inside a live session hook."""
    try:
        items = list(cache.items())[-AGY_CACHE_MAX:]
        path = agy_cache_path(trace)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(dict(items)), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        pass


def build_agy_record(data: dict, agy_event: str, cache: dict) -> dict:
    """Antigravity payload -> the same record shape Cursor writes.

    `tool` and `path` exist ONLY on PreToolUse; PostToolUse carries neither. The
    tool name is remembered in a sidecar cache and replayed onto the matching
    PostToolUse, because `request_tool` is rolled up exclusively from postToolUse
    rows — without the replay every Antigravity tool call would be invisible.
    `path` is deliberately NOT replayed: `request_file` counts any row carrying a
    path, so replaying it would double-count every file touch.
    """
    call = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    conv = str(data.get("conversationId") or "")
    step_idx = data.get("stepIdx")
    inv_id = data.get("invocationId") or data.get("invocation_id")
    if inv_id is not None:
        inv_id = str(inv_id)
    elif conv and step_idx is not None:
        inv_id = f"{conv}:{step_idx}"
    elif conv:
        inv_id = conv

    tool = ""
    path = ""
    if agy_event == "PreInvocation":
        for key in ("userMessage", "user_message", "prompt", "message", "input", "text"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                record_prompt = val.strip()
                break
        else:
            record_prompt = ""
    else:
        record_prompt = ""

    if agy_event == "PreToolUse":
        tool = str(call.get("name") or "")
        for key in ("AbsolutePath", "path", "file_path", "TargetFile"):
            if isinstance(args.get(key), str) and args[key]:
                path = args[key]
                break
    elif agy_event == "PostToolUse":
        entry = cache.get(f"{conv}:{step_idx}")
        if isinstance(entry, dict):
            tool = str(entry.get("tool") or "")

    workspace = data.get("workspacePaths")
    cwd = workspace[0] if isinstance(workspace, list) and workspace else ""

    record = {
        "at": iso_now(),
        "pid": os.getpid(),
        "event": AGY_EVENT_MAP[agy_event],
        "tool": tool,
        "path": path,
        "attachments": [],
        "ruleFiles": [],
        "fileAttachments": [],
        "conversationId": conv,
        "sessionId": conv,
        "keys": sorted(k for k in data.keys())[:40],
        "payload": scrub(data),
    }
    if step_idx is not None:
        record["stepIdx"] = step_idx
    if cwd:
        record["cwd"] = cwd
    if inv_id:
        record["generationId"] = inv_id
    if record_prompt:
        cap = MAX_STR
        record["prompt"] = record_prompt[:cap] + (
            f"…(len={len(record_prompt)})" if len(record_prompt) > cap else ""
        )

    shell_cmd = shell_command_from_args(args) if agy_event == "PreToolUse" else ""
    event_name = record.get("event") or ""
    dtypes = decision_event_types(event_name, tool, record.get("ruleFiles") or [], shell_cmd)
    if dtypes:
        record["decisionEventType"] = dtypes[0]
        if len(dtypes) > 1:
            record["decisionEventTypes"] = dtypes
    if "pre_guard_shell" in dtypes and shell_cmd:
        record["shellCommand"] = shell_cmd[:MAX_STR]

    return record


def shell_command_from_args(args: dict) -> str:
    if not isinstance(args, dict):
        return ""
    for key in ("command", "Command", "cmd", "script", "input", "text"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def is_shell_tool_name(tool: str) -> bool:
    name = (tool or "").strip()
    if not name:
        return False
    if SHELL_TOOL_RE.search(name):
        return True
    return name.lower() in ("shell", "bash", "terminal")


def decision_event_types(
    event: str, tool: str, rule_files: list, shell_command: str = ""
) -> list:
    """Map hook events to Decision Facade event types (WP4)."""
    ev = (event or "").strip()
    tool_l = (tool or "").lower()
    out: list = []
    if ev in ("beforeSubmitPrompt", "preInvocation", "PreInvocation"):
        out.append("turn_start")
        if rule_files:
            out.append("route_attach")
    elif ev in ("preToolUse", "PreToolUse"):
        if is_shell_tool_name(tool) or shell_command:
            out.append("pre_guard_shell")
    elif ev == "beforeShellExecution":
        out.append("pre_guard_shell")
    return out


def build_record(data: dict) -> dict:
    event = (
        data.get("hook_event_name")
        or data.get("event")
        or data.get("hookEventName")
        or data.get("type")
        or ""
    )
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    raw_attachments, rule_files, file_attachments = split_attachments(data.get("attachments"))

    record = {
        "at": iso_now(),
        "pid": os.getpid(),
        "event": event,
        "tool": data.get("tool_name") or data.get("tool") or "",
        "path": (
            tool_input.get("path")
            or tool_input.get("file_path")
            or data.get("path")
            or data.get("file_path")
            or ""
        ),
        "attachments": scrub(raw_attachments),
        "ruleFiles": rule_files,
        "fileAttachments": file_attachments,
        "keys": sorted(k for k in data.keys())[:40],
        "payload": scrub({k: v for k, v in data.items() if k != "attachments"}),
    }

    # `afterFileEdit` / `preToolUse` carry whole diffs; keep the count, drop the body.
    edits = data.get("edits")
    if isinstance(edits, list):
        record["editsCount"] = len(edits)
        record["payload"].pop("edits", None)

    # `beforeSubmitPrompt` carries the literal prompt. Keep a bounded prefix so a
    # turn can be identified later without storing the whole conversation.
    prompt = data.get("prompt")
    if isinstance(prompt, str) and prompt:
        record["prompt"] = prompt[:MAX_STR] + (f"…(len={len(prompt)})" if len(prompt) > MAX_STR else "")

    for src, dst in (
        ("context_tokens", "contextTokens"),
        ("context_window_size", "contextWindow"),
        ("context_usage_percent", "contextPercent"),
        ("session_id", "sessionId"),
        ("conversation_id", "conversationId"),
        ("generation_id", "generationId"),
        ("subagent_type", "subagentType"),
        ("subagent_id", "subagentId"),
        ("cwd", "cwd"),
    ):
        if src in data:
            record[dst] = data.get(src)

    tool_name = record.get("tool") or ""
    dtypes = decision_event_types(event, tool_name, rule_files)
    if dtypes:
        record["decisionEventType"] = dtypes[0]
        if len(dtypes) > 1:
            record["decisionEventTypes"] = dtypes
    if "pre_guard_shell" in dtypes:
        cmd = tool_input.get("command") or data.get("command") or ""
        if isinstance(cmd, str) and cmd.strip():
            record["shellCommand"] = cmd.strip()[:MAX_STR]

    return record


def find_config():
    """Walk up from cwd for the repo-root config. Returns (root, config_path)."""
    root = Path.cwd().resolve()
    for candidate in [root, *root.parents]:
        cfg = candidate / CONFIG_NAME
        if cfg.is_file():
            return candidate, cfg
    return None, None


def tracking_disabled() -> bool:
    """Is tracking off? Called before any other work, so keep it cheap.

    Order matters: the env var is free, the config walk is a handful of stats,
    and the sentinel is one more. When the answer is "off" the tracer must cost
    nothing beyond reading stdin — no JSON parse, no record build, no write.
    """
    if os.environ.get("HARNESS_MONITOR_DISABLED") == "1":
        return True
    root, cfg_path = find_config()
    if cfg_path is None:
        # No config yet: keep tracing, so the tool still works before adoption.
        return False
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(cfg, dict):
        return False
    tracking = cfg.get("tracking") or {}
    if tracking.get("enabled") is False:
        return True
    sentinel = Path(tracking.get("sentinelPath") or DEFAULT_SENTINEL)
    if not sentinel.is_absolute():
        sentinel = root / sentinel
    return sentinel.exists()


def main() -> int:
    agy_event = parse_event(sys.argv[1:])
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""

    # Toggle fast-path. A disabled harness performs NO action: no parse, no walk,
    # no write, nothing the server could pick up. This is checked before anything
    # else so "off" really means off.
    if tracking_disabled():
        sys.stdout.write(hook_response(fast_shape(agy_event), agy_event))
        return 0

    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    shape = detect_shape(data)

    try:
        if isinstance(data, dict) and data:
            harness = parse_harness(sys.argv[1:])
            if not harness:
                harness = discover_harness()
            if harness:
                if not shape:
                    shape = shape_of(harness)
                p = trace_path(harness)
                if shape == ANTIGRAVITY_SHAPE:
                    # Antigravity: normalize into the Cursor record shape, then
                    # remember this PreToolUse's tool name so the PostToolUse that
                    # arrives for the same (conversationId, stepIdx) can name it.
                    cache = load_agy_cache(p)
                    record = build_agy_record(data, agy_event, cache)
                    record["harness"] = harness
                    if agy_event == "PreToolUse":
                        cache[f"{record.get('conversationId', '')}:{record.get('stepIdx')}"] = {
                            "tool": record.get("tool") or "",
                            "path": record.get("path") or "",
                        }
                        save_agy_cache(p, cache)
                else:
                    record = build_record(data)
                    record["harness"] = harness
                p.parent.mkdir(parents=True, exist_ok=True)
                with p.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            # No harness resolvable -> write nothing rather than write somewhere wrong.
    except Exception:
        pass  # never let the tracer affect the session

    sys.stdout.write(hook_response(shape or fast_shape(agy_event), agy_event))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        _ev = parse_event(sys.argv[1:])
        sys.stdout.write(hook_response(fast_shape(_ev), _ev))
        raise SystemExit(0)
