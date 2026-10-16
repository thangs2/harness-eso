---
description: harness-eso MCP — codegraph + agentmemory-mcp (.cursor/mcp.json)
layer: core
alwaysApply: false
version: "1.1.0"
canonical: docs/03.cursor-mcp.md
globs: packages/harness-eso-core/**,packages/harness-host-generic/**,.cursor/mcp.json
---

# Harness tooling (harness-eso MCP)

**Workspace MCP:** `.cursor/mcp.json` — **không** dùng `x79/.cursor/mcp.json` trong window này. Isolation: `core.workspace-isolation.mdc`.

Adapter id (COLLECT): `docgraph-cli`, `codegraph-cli`, `agentmemory-mcp`, `deepseek-mcp`.

## MCP trong repo (`.cursor/mcp.json`)

| Server | Tool | Ghi chú |
|--------|------|---------|
| `codegraph` | `codegraph_explore` | `--path` = **harness-eso** |
| `agentmemory-mcp` | `memory_smart_search`, `memory_save` | `:3111` |
| `deepseek-direct` | `ask_deepseek_flash`, `ask_deepseek_pro` | `x79/installation/deepseek` |

Setup: `documents/01.overview/03.cursor-mcp.md` · mẫu: `mcp.example.json` (docgraph chạy CLI `docgraph --q`).

## Khi nào gọi gì

| Cần | Tool |
|-----|------|
| Symbol / flow / blast radius **product** | `codegraph_explore` + `projectPath` harness-eso |
| Consumer-only paths (ingest, hooks trên x79) | `codegraph_explore` + `projectPath` `../x79` (một lần, không đổi MCP server) |
| Spec ESO, observe API | CLI `docgraph --q` (cwd x79 hoặc `--repo ../x79`) |
| Context phiên | `memory_smart_search` |
| Thiết kế/debug sâu | DeepSeek (nếu đã cấu hình) — không dùng để chọn route |

## Docgraph aliases (cwd x79)

| Query | Read sau fetch |
|-------|----------------|
| `harness-tooling` | `core.harness-tooling.mdc`, x79 `17.operational-runbook-eso.md` |
| `decision-facade` | `02.dpef-v2-pipeline.md`, `07.jev-and-decision-policy.md` |
| `harness-eso` | `00.index.md`, skill `harness-eso-implement` |
