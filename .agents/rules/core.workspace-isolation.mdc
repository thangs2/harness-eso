---
description: Isolate harness-eso Cursor workspace from x79 — rules, skills, MCP
layer: core
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
---

# Workspace isolation (harness-eso)

**After `core.law-gate` + `AGENTS.md`.** Một **Cursor window = một repo gốc**. Không merge rule/skill/MCP giữa hai workspace.

## harness-eso (window này)

| Thành phần | Chỉ dùng |
|------------|----------|
| Law agent | `AGENTS.md`, `.cursor/rules/*` **trong repo này** |
| Skills | `.cursor/skills/harness-*` — **không** `mu-*`, `brain-dispatch` |
| MCP | `.cursor/mcp.json` — codegraph (**harness-eso**), docgraph repo **x79**, agentmemory, deepseek |
| Codegraph `projectPath` | Root **harness-eso** (`packages/*`, `qc/*`) |
| Implement | `@mu/harness-*` trong monorepo |

## x79 (window khác)

| Thành phần | Chỉ dùng |
|------------|----------|
| Rules | `core.harness-consumer`, `core.harness-eso`, `stack.mu.*`, `delivery.*`, … |
| Skills | `mu-*`, `brain-dispatch`, … |
| MCP | `x79/.cursor/mcp.json` — codegraph **x79**, deepseek, … |
| Implement | `backend/mu-*`, `frontend/`, consumer `.harness/` |

## Chỉ đọc chéo (không import rule x79)

- **Spec / law:** `../x79/document/harness/02.harness-eso/` hoặc `docgraph` CLI với **cwd x79** (`core.harness-eso-spec.mdc`)
- **E2E verify:** mount consumer `HARNESS_REPO_ROOT=../x79` — không copy x79 rules vào đây

## Cấm

- Áp `stack.mu.*`, `sdlc.gov.*` (x79) lên sửa `packages/harness-*`
- Mở harness-eso nhưng dùng MCP codegraph `--path` trỏ x79 (trừ khi explore consumer-only với `projectPath` tạm)
- Symlink `x79/.cursor/rules` vào harness-eso
