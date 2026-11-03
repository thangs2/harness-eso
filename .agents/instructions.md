# Antigravity instructions — harness-eso

**Not law** — supreme SoT is **`AGENTS.md`** (repo root).

## Forced chain (Cursor & Antigravity)

```text
Host Agent session (Cursor / Antigravity)
  → core.law-gate (step 1: Read AGENTS.md — mandatory)
  → AGENTS.md          — supreme SoT
  → core.workspace-isolation → core.harness-agents → core.harness-product
  → core.slp (task >1 tầng — 7 worker · `harness-engineering-team`)
  → glob rules / skills (must not contradict AGENTS.md)
```

## SLP on Antigravity Host

- **Workspace customizations root:** `.agents/`
- **Subagents:** `.agents/agents/*-runtime.md` (**7 workers**, exact mirror of `.cursor/agents/`):
  1. `scout-runtime.md` — Recon (context pack <= 300 words)
  2. `plan-runtime.md` — Work slicer (disjoint slice table)
  3. `build-runtime.md` — Scoped peer developer (one slice inside `allowed_files`)
  4. `verify-runtime.md` — Deterministic test/build runner
  5. `audit-runtime.md` — Independent rubric evaluator (score >= 85, 0 CRITICAL)
  6. `fixbug-runtime.md` — Surgical fixer (derived `allowed_files` from findings)
  7. `qc-runtime.md` — Scenario executor (runs on operator request)
- **Orchestration:** Lead orchestrates via `invoke_subagent` (`Model: inherit` or `flash` for mechanical slices; `TypeName: "<role>-runtime"`).
- **Communication:** Blackboard DAG — workers communicate strictly with Lead via structured JSON receipts. No worker-to-worker crosstalk.
- **Human Supervisor (S):** Operator outside the loop. 3 S-Gates: (1) approve plan, (2) resolve escalations (3x loop failure), (3) sign off Human In Review → Done.
- **Prompt contract (always 4 parts):** `INV ids` · `AC rows in scope` · `allowed_files` · `verify command`.

## Catalogs & Mappings

| Concern | Cursor | Antigravity |
|---------|--------|-------------|
| Gate | `.cursor/rules/core.law-gate.mdc` | `AGENTS.md` (user_rules) |
| Law | `AGENTS.md` | `AGENTS.md` |
| Rules | `.cursor/rules/` | `.agents/rules/` |
| Skills | `.cursor/skills/` | `.agents/skills/` |
| Subagents | `.cursor/agents/` | `.agents/agents/` |
| MCP | `.cursor/mcp.json` | `call_mcp_tool` (`agentmemory`, `codegraph`, `deepseek-direct`) |
| Invariants | `docs/05.development/02.invariants.md` | `docs/05.development/02.invariants.md` |
