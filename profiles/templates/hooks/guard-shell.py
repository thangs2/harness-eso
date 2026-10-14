#!/usr/bin/env python3
"""Deny shell commands that drop a database, target a remote data store, or write secrets.

And — since a `cat > sdlc/foo.md` walks straight past the Write gate — deny protected-path writes
made through the shell. `guard-write.py` only runs on Write/StrReplace, so the shell was a fully open
second channel: one turn wrote 7 protected files that way while the observer recorded them all as
*reads*. See document/harness doc §28.

The **parser** for that lives in the host pack (`shell-targets`), not here, so there is exactly one
implementation of "which files does this command write". The **policy** — which paths are protected —
stays in this repo, and is imported from `guard-write.py` rather than copied, so the two guards cannot
disagree about what they protect.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / ".harness" / "decision-policy.json"
PACK_HOOK = ROOT / ".harness" / "host-pack" / "harness-hook.mjs"
# Which harness tree this hook lives in — `.cursor` or `.agents`. The pack takes `cursor|agents` and
# uses it only to pick a response dialect, which this hook does not consume; it must still be a value
# the pack recognises so a future shape change cannot silently pick the wrong one.
TREE = Path(__file__).resolve().parents[1].name.lstrip(".")

LOCAL_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "mongo",
    "mongodb",
    "redis",
    "host.docker.internal",
}
URL_RE = re.compile(
    r"(?:mongodb(?:\+srv)?|postgres|postgresql|mysql|redis)://[^\s'\"]+",
    re.I,
)
HOST_KV_RE = re.compile(r"(?:Host|Server)=([^;\s'\"]+)", re.I)
FLAG_HOST_RE = re.compile(r"(?:-h|--host)(?:=|\s+)(\S+)", re.I)
DROP_DB_RE = re.compile(r"\bdrop\s+database\b|\bdropdb\b|dropdatabase\s*\(", re.I)
SECRET_REDIRECT_RE = re.compile(
    r"(?:>>?|\btee\b)\s+\S*(?:\.env(?:\.\w+)?|credentials\.json|id_rsa|id_ed25519|\.pem|\.pfx)\b",
    re.I,
)
SHELL_TOOL_RE = re.compile(
    r"shell|terminal|bash|run_command|run_terminal|execute",
    re.I,
)

_OUTPUT_SHAPE = "cursor"


def _load_protected():
    """Import the protected-path policy from `guard-write.py`, which owns it.

    Both guards must protect the same paths. Keeping a second copy here is how they would drift, so
    the module is loaded by path — the filename has a hyphen and is not importable by name. Its body
    is constants and functions only (`main()` is `__main__`-guarded), so importing it has no effect.
    """
    spec = importlib.util.spec_from_file_location(
        "guard_write", Path(__file__).with_name("guard-write.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    _GW = _load_protected()
    PROTECTED_PREFIXES = tuple(_GW.PROTECTED_PREFIXES)
    # Reused rather than re-derived: product state is one location, and two definitions of it is how the
    # consent file would come to be guarded in one place and writable in another.
    product_state_dir = _GW.product_state_dir
    PROTECTED_EXACT = frozenset(_GW.PROTECTED_EXACT)
except Exception:  # pragma: no cover - a broken sibling guard must not silently unprotect
    PROTECTED_PREFIXES = ()
    PROTECTED_EXACT = frozenset()

    def product_state_dir():
        # No sibling guard to ask. Falls back to the same rule, because failing to locate product state
        # must not quietly drop the check that keeps consent out of the agent's reach.
        override = os.environ.get("HARNESS_PRODUCT_STATE_DIR", "").strip()
        return Path(override) if override else Path.home() / ".harness"

# Cheap over-approximation, used ONLY to decide whether the pack is worth spawning. It may say
# "maybe" for a read-only command; it must never say "no" for a command that writes. The verdict
# itself always comes from the pack, so there is no second parser here.
MAYBE_WRITE_RE = re.compile(r">|\btee\b|\bcp\b|\bmv\b|\btouch\b|\bsed\b|\bpython|\binstall\b|\bdd\b")


def guards_unavailable() -> str:
    """`guards.unavailable` from policy: `deny` (default) or `warn`."""
    try:
        data = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        value = str(data.get("guards", {}).get("unavailable", "deny")).lower()
        return value if value in ("deny", "warn") else "deny"
    except (OSError, json.JSONDecodeError):
        # An unreadable policy must not loosen a guard.
        return "deny"


def pack_shell_targets(command: str):
    """Ask the pack which files this command writes.

    Returns `(ok, targets)`. `ok=False` means the question could not be answered — the caller decides
    what that means, from policy, rather than this function assuming `allow`.
    """
    node = shutil.which("node") or shutil.which("bun")
    if not node or not PACK_HOOK.is_file():
        return False, []
    try:
        proc = subprocess.run(
            [node, str(PACK_HOOK), "--hook", "shell-targets", "--tree", TREE],
            input=json.dumps({"command": command}),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        # Broad on purpose. Anything raised here means the question went unanswered, and letting it
        # escape would hit `main()`'s outer handler, which is fail-OPEN unless Jev is active — so a
        # typo in this function would silently disable the check. Returning "unanswered" instead puts
        # the decision back where it belongs, in the caller's posture.
        return False, []
    if proc.returncode != 0:
        return False, []
    try:
        answer = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return False, []
    # No `targets` key means the pack emitted a permission payload, not an answer.
    if not isinstance(answer.get("targets"), list):
        return False, []
    if answer.get("writeIntent") is not True and not answer["targets"]:
        return True, []
    return True, [str(t) for t in answer["targets"]]


def protected_hit(targets: list) -> str:
    """The first target this repo protects, in repo-relative form — **unless consent covers it**.

    The tier comes from `guard-write.py`'s `path_mode`, which resolves the consumer's `paths` policy, so
    the guard that answers "which paths need a gate" is the same one the Write tool uses. This function
    only maps a shell target onto that answer.

    Consent is consulted here too, and that is not optional. Without it the two channels disagree about
    the same path — a person approves `sdlc/08.wbs/`, the Write tool proceeds, and the shell still
    refuses — which makes the approval look broken and teaches the agent to route around it. One
    approval has to open both channels or neither.
    """
    root = str(ROOT)
    for raw in targets:
        rel = raw[len(root) + 1 :] if raw.startswith(root + "/") else raw
        # NOT `lstrip("./")` — `lstrip` takes a character SET, so it ate the leading dot of
        # `.cursor/rules/x.mdc` and produced `cursor/rules/x.mdc`, which matches no protected prefix.
        # Every dot-directory (`.cursor/`, `.agents/`) was silently unprotected because of this.
        if rel.startswith("./"):
            rel = rel[2:]
        try:
            mode = _GW.path_mode(rel)
            # Consent opens the `ask` tier and **only** the `ask` tier. `locked` means no gate can open
            # it — it is not a path a person approves, it is a path the human reserves. Letting an
            # approval reach it would make the strongest tier the weakest, since consent is the one
            # record a person can produce casually.
            if mode == "ask" and _GW.consent_covers(rel):
                continue
        except Exception:
            # A sibling guard that cannot answer is not permission to proceed.
            return rel or ""
        if mode:
            return rel
    return ""


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


def extract_command(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    direct = data.get("command")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    call = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
    name = str(call.get("name") or "")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    for key in ("command", "Command", "cmd", "script", "input", "text"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    if name and SHELL_TOOL_RE.search(name):
        return str(args.get("command") or args.get("Command") or "").strip()
    return ""


def allow():
    if _OUTPUT_SHAPE == "antigravity":
        sys.stdout.write('{"decision":"allow"}\n')
    else:
        sys.stdout.write('{"permission":"allow"}\n')


def deny(message: str):
    if _OUTPUT_SHAPE == "antigravity":
        payload = {"decision": "deny", "reason": message}
        sys.stdout.write(json.dumps(payload) + "\n")
        return
    payload = {
        "permission": "deny",
        "user_message": message,
        "agent_message": message,
    }
    sys.stdout.write(json.dumps(payload) + "\n")


def host_of_url(url: str) -> str:
    rest = url.split("://", 1)[1]
    rest = rest.split("/", 1)[0]
    if "@" in rest:
        rest = rest.split("@", 1)[1]
    rest = rest.split(":", 1)[0]
    return rest.strip("[]").lower()


def remote_hosts(command: str) -> list[str]:
    found = []
    for match in URL_RE.findall(command):
        found.append(host_of_url(match))
    for match in HOST_KV_RE.findall(command):
        found.append(match.strip().lower())
    for match in FLAG_HOST_RE.findall(command):
        found.append(match.strip().strip("'\"").lower())
    return [host for host in found if host and host not in LOCAL_HOSTS]


def main() -> int:
    global _OUTPUT_SHAPE
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        allow()
        return 0

    _OUTPUT_SHAPE = detect_shape(data)
    command = extract_command(data)
    if not command.strip():
        allow()
        return 0

    hook_payload = dict(data) if isinstance(data, dict) else {}
    hook_payload["command"] = command

    lowered = command.lower()
    if DROP_DB_RE.search(command):
        deny("Database guard: DROP DATABASE is blocked.")
        return 0
    if SECRET_REDIRECT_RE.search(command):
        deny("Secret-file write via shell is blocked.")
        return 0

    hosts = remote_hosts(command)
    db_client = any(
        token in lowered
        for token in ("mongosh", "mongo ", "redis-cli", "psql", "mysql", "sqlcmd")
    )
    if hosts and db_client:
        deny(
            "Data-store command targets a non-local host ("
            + ", ".join(hosts)
            + "). Local hosts only."
        )
        return 0

    # Protected-path writes via the shell. Prefiltered, because the answer comes from a node spawn
    # (~46ms) and a read-only command should not pay for it. The prefilter is deliberately loose: it
    # errs towards asking, and the verdict always comes from the pack.
    if MAYBE_WRITE_RE.search(command):
        ok, targets = pack_shell_targets(command)
        if not ok:
            if guards_unavailable() == "deny":
                deny(
                    "Shell guard unavailable: cannot determine which paths this command writes "
                    "(host pack missing or failed). `guards.unavailable` is `deny`."
                )
                return 0
        else:
            state = str(product_state_dir())
            for t in targets:
                text = str(t).replace("\\", "/")
                # Product state first, and on the raw target: it holds the consent records, so a write
                # there would let the shell grant the approval that the shell guard is enforcing.
                if text == state or text.startswith(state + "/"):
                    deny(
                        f"Product state is not shell-writable: {text}. It holds the project registry, "
                        "the observe databases and the consent records."
                    )
                    return 0
            hit = protected_hit(targets)
            if hit:
                deny(
                    "Protected path write via shell: "
                    + hit
                    + ". Use the Write tool instead so the ESO/Brain gate applies to it."
                )
                return 0

    allow()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # A guard that cannot decide must not decide "safe". This used to `allow()` unless Jev happened
        # to be `active`, which meant a bug in ANY rule above silently stopped the whole guard — and it
        # is how a `NameError` in the protected-path check first went unnoticed: every command was
        # permitted, with no signal.
        #
        # The posture now matches the host pack's convention (`errorPosture` in `dispatch.mjs`):
        # block by default, and honour `guards.unavailable` where an operator has decided that
        # availability matters more than enforcement.
        if guards_unavailable() == "deny":
            deny(
                "Shell guard error (fail-closed). "
                "Set guards.unavailable=warn in .harness/decision-policy.json to allow shell on guard failure."
            )
        else:
            allow()
        raise SystemExit(0)
