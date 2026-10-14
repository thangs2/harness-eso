#!/usr/bin/env python3
"""Antigravity PreToolUse — guard-write then guard-shell (single stdin read)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def run_hook(script: Path, argv: list[str], raw: bytes) -> str:
    proc = subprocess.run(
        [sys.executable, str(script), *argv],
        input=raw,
        capture_output=True,
        cwd=ROOT,
    )
    return (proc.stdout or b"").decode("utf-8", errors="replace").strip()


def parse_out(text: str) -> dict:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def is_deny(body: dict) -> bool:
    return body.get("decision") == "deny" or body.get("permission") == "deny"


def main() -> int:
    raw = sys.stdin.read().encode("utf-8")

    write_out = run_hook(HERE / "guard-write.py", [], raw)
    if is_deny(parse_out(write_out)):
        sys.stdout.write(write_out + ("\n" if not write_out.endswith("\n") else ""))
        return 0

    shell_out = run_hook(HERE / "guard-shell.py", [], raw)
    if is_deny(parse_out(shell_out)):
        sys.stdout.write(shell_out + ("\n" if not shell_out.endswith("\n") else ""))
        return 0

    sys.stdout.write('{"decision":"allow"}\n')
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.stdout.write(json.dumps({"decision": "deny", "reason": f"pre-tool-use error: {exc}"}) + "\n")
        raise SystemExit(0)
