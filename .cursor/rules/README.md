# Cursor rules — harness-eso

**Chain:** IDE → rules → **`core.law-gate`** → **Read `AGENTS.md`** → other rules.

**Isolation:** only rules in this folder — not `x79/.cursor/rules`. MCP: `.cursor/mcp.json`.

| Rule | When |
|------|------|
| **`core.law-gate.mdc`** | **Always first** — force Read `AGENTS.md`; supremacy |
| `core.workspace-isolation.mdc` | Always — after law loaded |
| `core.artifacts.mdc` / `.md` | Always — `comments/` là **scratch** (gitignored, bị xoá); tài liệu bền → `docs/<NN.topic>/`, luật → `sdlc/` |
| `core.harness-agents.mdc` | Always — pipeline after law |
| `core.paseo-provider.mdc` / `.md` | Always — Paseo → DSH: capability là **profile-scoped**; recon bằng CLI `--path "$PWD"` |
| `delivery.jira-agent-execution.mdc` / `.md` | Jira parent-child rollup — §6.1 · script `jira-rollup` |
| `core.slp.mdc` | Task chạm **>1 package/tầng** — 7 worker · slice rời nhau · rubric ≥85 |
| `core.harness-product.mdc` | Always — boundary/commands after law |
| `core.harness-tooling.mdc` | codegraph · docgraph · agentmemory · deepseek |
| `core.harness-eso-spec.mdc` | Contract/spec, observe API, docs |
| `core.codegraph.mdc` | `packages/**`, `qc/**` |
| `core.doc.mermaid.mdc` | `docs/**` mermaid fences, `pipeline-diagrams.ts` |
| `pkg.observe-server.mdc` | `harness-observe-server/**` |
| `pkg.observatory-ui.mdc` | Observatory + Console SPA |

**Index:** `.cursor/instructions.md` · **Skills:** `.cursor/skills/SOT-MAP.md`

**x79** (consumer): separate window — `core.harness-consumer`, `stack.mu.*`, etc.

Spec shards (read): `../x79/document/harness/02.harness-eso/`.
