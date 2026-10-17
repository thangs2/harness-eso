---
name: eso-verify
description: Verification workflow for Harness ESO code changes, local tests, and Observatory status.
---

# ESO Verification Skill

Verify all changes before finalizing a task:

1. **Local Test Suite:** Run tests with bounded output (e.g. `bun test 2>&1 | tail -n 25` or repo test command).
2. **Git Status & Diff:** Check `git status -s` to ensure zero unstaged or accidental files.
3. **Observatory Health:** Verify that Observatory shows clean turns with zero unhandled guard errors or blocked writes.
