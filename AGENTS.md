# Agent harness — harness-eso (dev repo)

Repo này **ship** sản phẩm Harness ESO (`@mu/harness-*`). Agent làm việc **trong monorepo** theo file này — **không** chạy full pipeline ESO (preflight sidecar, `init profile`) trên chính `harness-eso`.

**Consumer đầy đủ:** repo **x79** (sibling `../x79`) — observe, hooks, `decision-policy.json`. Thiết kế ban đầu: `x79/document/harness/02.harness-eso/` — **đã out of date, không dùng làm law**; nguồn hiện hành là code repo này + gói `documents/`.

**Cursor Windows:** mở **folder gốc = harness-eso**; xem `docs/02.cursor-windows.md`. Docker: `docker/observatory.ps1` (không dùng `observe.sh`).

**Cursor agent (forced):** IDE loads `.cursor/rules/` → **`core.law-gate.mdc`** bắt buộc **Read file này (`AGENTS.md`)** mỗi phiên trước khi làm việc; rule khác chỉ bổ sung, không thay law. Catalog: `.cursor/instructions.md` · MCP `.cursor/mcp.json` (`docs/03.cursor-mcp.md`).

**Documentation pack (đọc trước khi sửa luồng dữ liệu):** `documents/00.README.md` — mô tả sản phẩm là gì, chạy thế nào, và **`documents/05.development/02.invariants.md`** liệt kê các bất biến kèm defect đã sinh ra chúng. Đây là gói bàn giao độc lập: không cần đọc repo consumer để hiểu sản phẩm.

---

## Mục tiêu

- Sửa bug, thêm feature, test trong `packages/*` và `qc/*`.
- Giữ diff nhỏ, khớp style hiện có.
- Khi đụng hành vi runtime trên consumer → verify trên **x79** (hoặc repo có `harness.config.json`), không giả định harness-eso đã provision ESO.

---

## Công cụ được dùng (bắt buộc khi cần)

Agent **được phép và nên** dùng các MCP / tool sau khi tra cứu code, doc, memory, hoặc cần reasoning nặng:

| Nguồn | Khi dùng | Gợi ý |
|--------|-----------|--------|
| **Codegraph** | Luồng gọi, symbol, blast radius trong **product** | MCP `codegraph` trong **`.cursor/mcp.json`** (index harness-eso). `codegraph_explore` · `projectPath` = root harness-eso; consumer-only → `../x79`. Không `.codegraph/` → `codegraph init -i` hoặc Read/Grep. |
| **Docgraph** | Law / spec x79 (read-only) | MCP **`docgraph`** → `docgraph_query` (`DOCGRAPH_REPO=../x79`). Hoặc CLI `docgraph --q` cwd x79. |
| **AgentMemory** | Context phiên, preference operator | MCP **`agentmemory-mcp`** trong `.cursor/mcp.json` (`memory_smart_search` / `memory_save`). |
| **DeepSeek** | Phân tích sâu, thiết kế, debug khó | MCP **`deepseek-direct`** trong `.cursor/mcp.json`: **`ask_deepseek_flash`** (default), **`ask_deepseek_pro`** khi cần. |

**Brain tier:** quyết định ở đây (AGENTS.md). ESO preflight trên x79 chỉ gợi ý `brainTierHint`.

**Không thay thế:** sửa file vẫn dùng editor tools; shell khi cần `bun test`, docker, v.v.

---

## Thứ tự làm việc (gợi ý)

1. Đọc yêu cầu + file liên quan (Read/Grep hoặc Codegraph).
2. Docgraph nếu câu hỏi về contract / WBS / observe API.
3. AgentMemory nếu có context dài từ phiên trước.
4. Implement trong repo; chạy test cục bộ.
5. DeepSeek chỉ khi cần suy luận nhiều bước hoặc review kiến trúc — không gọi cho thay đổi 1–2 dòng đã rõ.

---

## Layout monorepo

```text
packages/
  harness-foundation/      paths, policy load, init-profile, workspace
  harness-eso-core/        COLLECT, gate, adapters (docgraph, codegraph, agentmemory)
  harness-decision/        L0 + Jev facade
  harness-host-generic/    Cursor/Antigravity hooks → sidecar
  harness-observe-server/  ingest worker, REST, Observatory static
  harness-console/         wizard UI (:8791)
  harness-observatory/     monitor UI (:8792)
  harness-cli/             observe, init profile
profiles/                  generic-eso.json, plugin-catalog, host superset
qc/                        node:test integration
docker/                    observe image, compose.harness.yml
docs/                      operator getting started
```

Adapter id trong policy (tham chiếu khi sửa core): `docgraph-cli`, `codegraph-cli`, `agentmemory-mcp`, brain `deepseek-mcp`.

---

## Lệnh dev (host có Bun)

```bash
bun install
bun test                              # spine + qc
bun run test:observatory              # Vitest observatory
bun run build:observatory             # trước khi bundle UI trong observe-server
node packages/harness-observe-server/src/server.mjs --root ../x79   # integration
```

Operator (x79), không bắt buộc khi chỉ sửa code harness-eso:

```bash
./install.sh && ./harness up          # Docker observe :8792
./harness console                     # :8791
./harness init profile ../x79 --id x79
```

---

## Quy ước code

- ESM (`.mjs`), workspaces `@mu/harness-*`.
- Test: `node:test` trong `qc/` và `packages/*/src/*.test.mjs`.
- Không commit `.harness/` (local state). Không sửa tay `harness.config.json` trên x79 nếu flow chuẩn là `init profile` — trừ khi task yêu cầu.
- Chỉ commit khi user yêu cầu.

---

## Phạm vi repo vs x79

| Việc | Repo |
|------|------|
| Sửa observe API, hooks, adapters, Console | **harness-eso** |
| Chạy agent app với docgraph/codegraph MCP x79 | **x79** (mở workspace x79 hoặc MCP `projectPath` → x79) |
| Kiểm tra preflight / gap / brain guard | **x79** sau provision + `./harness up` |

Khi task mơ hồ “fix harness”, mặc định code trong **harness-eso**; mô tả verify trên **x79** nếu là hành vi end-to-end.
