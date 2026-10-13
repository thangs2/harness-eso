---
description: harness-eso agent pipeline — AGENTS.md workflow, MCP recon, verify
layer: core
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
---

# Agent pipeline (harness-eso)

**Prerequisite:** `core.law-gate.mdc` — `AGENTS.md` already **Read** this session. Repo **ship** `@mu/harness-*`; không full ESO consumer trên monorepo.

## Thứ tự (sau `AGENTS.md`)

1. **Yêu cầu** — phân loại: product code (`packages/*`) vs spec/law (x79 `document/harness/**`) vs E2E (verify trên x79).
2. **AgentMemory** — `memory_smart_search` trước task lớn hoặc khi user nhắc context cũ; `memory_save` khi user yêu cầu “nhớ”.
3. **Recon một vòng** — gom Read/Grep/`codegraph_explore`/docgraph trong một lượt; không grep+read lặp sau khi codegraph đã trả source.
4. **Law / contract** — docgraph hoặc Read shard x79 (`core.harness-eso-spec.mdc`); không đoán observe API từ README lẻ.
5. **Implement** — diff nhỏ, ESM `.mjs`, test `node:test` / Vitest theo package.
6. **DeepSeek** — `ask_deepseek_flash` mặc định; `ask_deepseek_pro` khi flash không đủ hoặc user chỉ định. **Không** gọi Brain chỉ để chọn rule/skill/route (System 1 = codegraph + docgraph + policy).
7. **Verify** — `bun test`; UI → `bun run build:observatory` + `bun run test:observatory`; E2E → skill `harness-verify`.

## Chọn rule theo task

| Path / task | Rule + skill |
|-------------|----------------|
| Luôn | `core.harness-product`, `core.harness-agents` |
| `packages/**` structure | `core.codegraph.mdc` |
| MCP / installers | `core.harness-tooling.mdc` |
| Spec ESO, observe contract | `core.harness-eso-spec.mdc` + `harness-eso-implement` |
| `harness-observe-server/**` | `pkg.observe-server.mdc` |
| `harness-observatory/**`, `harness-console/**` | `pkg.observatory-ui.mdc` |
| `docker/**`, `compose.harness.yml` | `core.harness-product` § Docker |
| `qc/**` | integration tests sau đổi spine |

## projectPath / cwd

| Nguồn | Root |
|-------|------|
| Code trong monorepo | `harness-eso` (workspace này) |
| Law, WBS, runbook | `../x79` |
| Transcript ingest, `.harness/` consumer | `../x79` (hoặc repo có `harness.config.json`) |

## Commit

Chỉ commit khi user yêu cầu. Không commit `.harness/`.
