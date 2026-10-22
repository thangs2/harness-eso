# Instructions index (not law)

**Do not treat this file as law.** Cursor loads **rules**; rules **force** **`AGENTS.md`**.

## Forced chain (harness-eso)

```text
IDE Agent session
  → .cursor/rules/* (alwaysApply)
  → core.law-gate.mdc  — step 1: Read AGENTS.md (mandatory)
  → AGENTS.md          — supreme SoT
  → core.workspace-isolation → core.harness-agents → core.harness-product
  → core.entrypoints (operator actions only via ./deploy.sh · provision.sh · verify-consumer.sh · console.sh)
  → glob rules / skills (must not contradict AGENTS.md)
```

| Catalog | Path |
|---------|------|
| Gate | `.cursor/rules/core.law-gate.mdc` |
| Law | **`AGENTS.md`** (repo root) |
| Rules | `.cursor/rules/README.md` |
| Skills | `.cursor/skills/SOT-MAP.md` |
| MCP | `.cursor/mcp.json` · `docs/03.cursor-mcp.md` |

**x79:** separate Cursor window — own rules/skills/MCP; no `stack.mu.*` here.
