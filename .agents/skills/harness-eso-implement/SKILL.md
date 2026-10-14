---
name: harness-eso-implement
description: Implements and extends @mu/harness-* in harness-eso monorepo using AGENTS.md, x79 ESO spec shards, and MCP recon (codegraph, docgraph, agentmemory, deepseek). Use for Observatory, observe-server, hooks, CLI, ESO core, or when user mentions harness-eso product work.
---

# harness-eso implement

## When

- Sửa/thêm trong `packages/*`, `qc/*`, `docker/*`, `profiles/*`
- Câu hỏi contract observe / preflight / ingest / decision ledger
- User mở workspace **harness-eso** (không phải implement mu-* trên x79)

## Preconditions

- **`core.law-gate`:** `Read AGENTS.md` đã xong phiên này (bắt buộc trước skill này)
- **Window:** folder gốc = **harness-eso** — rules/skills/MCP **chỉ** từ repo này (`core.workspace-isolation.mdc`)
- **MCP:** `.cursor/mcp.json` (codegraph, docgraph→x79, agentmemory, deepseek) — không symlink `x79/.cursor/mcp.json`
- Spec (read-only): `../x79/document/harness/02.harness-eso/00.index.md` hoặc `docgraph --q` với cwd x79
- Rules: `core.harness-product`, `core.harness-agents`, scoped rules theo path
- Consumer E2E: sibling **x79** với `harness.config.json` sau `harness init profile`

## Workflow

1. **Classify** — product-only vs cần verify consumer vs chỉ đọc spec.
2. **Recall** — `memory_smart_search` nếu task lớn hoặc liên quan quyết định trước.
3. **Law** — docgraph (`harness-tooling`, `decision-facade`, `harness-eso`) hoặc Read shard cụ thể.
4. **Code** — `codegraph_explore` với `projectPath` = harness-eso (hoặc x79 nếu consumer-only).
5. **Plan** — một recon round; diff nhỏ; khớp ESM `.mjs` / React patterns hiện có.
6. **Brain** — chỉ khi cần thiết kế/debug sâu: `ask_deepseek_flash` trước; Pro khi flash không đủ. Không Brain để chọn route.
7. **Test** — `bun test`; observatory → `bun run test:observatory` + `build:observatory`.
8. **E2E** (khi đụng runtime consumer) — skill `harness-verify`.

## Package map (ngắn)

| Package | Vai trò |
|---------|---------|
| `harness-foundation` | paths, workspace, init-profile |
| `harness-eso-core` | COLLECT, gate, adapters |
| `harness-decision` | L0, Jev facade |
| `harness-host-generic` | Cursor hooks → sidecar |
| `harness-observe-server` | REST, ingest, static UI |
| `harness-observatory` / `harness-console` | SPA |
| `harness-cli` | `harness observe`, init profile |

## Không làm trong repo này

- Full ESO preflight trên harness-eso thay cho consumer
- Sửa `document/mu/**` hoặc `backend/mu-*` (window x79)
- Commit trừ khi user yêu cầu

## Docgraph nhanh

```bash
cd ../x79 && docgraph --q "observe API"
cd ../x79 && docgraph --q "decision-facade"
```
