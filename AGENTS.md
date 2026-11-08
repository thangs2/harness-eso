# Agent harness — harness-eso (dev repo)

Repo này **ship** sản phẩm Harness ESO (`@mu/harness-*`). Agent làm việc **trong monorepo** theo file này — **không** chạy full pipeline ESO (preflight sidecar, `init profile`) trên chính `harness-eso`.

**Consumer đầy đủ:** repo **x79** (sibling `../x79`) — observe, hooks, `decision-policy.json`. Thiết kế ban đầu: `x79/document/harness/02.harness-eso/` — **đã out of date, không dùng làm law**; nguồn hiện hành là code repo này + gói `docs/`.

**Cursor Windows:** mở **folder gốc = harness-eso**; xem `docs/01.overview/02.cursor-windows.md`. Docker: `./deploy.sh <consumer>` · `./console.sh up`.

**Operator entrypoints (forced):** hành động trên consumer **chỉ** qua `./deploy.sh`, `./provision.sh`, `./verify-consumer.sh`, `./console.sh` (Windows: `harness.ps1 <command>`). Không gọi `node`/`bun`/`docker` trực tiếp để thay một bước của script — chi tiết `.cursor/rules/core.entrypoints.mdc`.

**Cursor agent (forced):** IDE loads `.cursor/rules/` → **`core.law-gate.mdc`** bắt buộc **Read file này (`AGENTS.md`)** mỗi phiên trước khi làm việc; rule khác chỉ bổ sung, không thay law. Catalog: `.cursor/instructions.md` · MCP `.cursor/mcp.json` (`docs/01.overview/03.cursor-mcp.md`).

**Luật làm việc trong `sdlc/` (bắt buộc trước khi đề xuất cấu trúc/tách folder):** [`sdlc/02.governance/04.agent-rules.md`](sdlc/02.governance/04.agent-rules.md) — 10 luật, mỗi luật kèm lỗi đã sinh ra nó. Điểm chết người: **A = `sdlc/` (toàn bộ artifact + luật), B = sản phẩm**; `sdlc/` **không** copy/ship/provision; consumer nhận **study sample**. Không nói "P7 đòi X" khi không trích được câu trong `P7`.

**Documentation pack (đọc trước khi sửa luồng dữ liệu):** `docs/00.README.md` — mô tả sản phẩm là gì, chạy thế nào, và **`docs/05.development/02.invariants.md`** liệt kê các bất biến kèm defect đã sinh ra chúng. Đây là gói bàn giao độc lập: không cần đọc repo consumer để hiểu sản phẩm.

---

## Mục tiêu

- Sửa bug, thêm feature, test trong `packages/*` và `qc/*`.
- Giữ diff nhỏ, khớp style hiện có.
- Khi đụng hành vi runtime trên consumer → verify trên **x79** (hoặc repo có `harness.config.json`), không giả định harness-eso đã provision ESO.

---

## Năng lực host — đọc trước khi làm bước recon

Repo này được dùng bởi **nhiều host**, và chúng **không cùng năng lực**. Bảng dưới đây là **đo thật** (2026-10-25 / 2026-11-03),
không phải mô tả thiết kế. Chi tiết + hệ quả: `sdlc/04.landscape/03.working-environment.md`.

| Năng lực | Cursor | Antigravity (AGY) | DSH `desktop` | DSH `paseo` (Paseo spawn) |
|---|---|---|---|---|
| `AGENTS.md` bơm vào context | ✅ | ✅ (user_rules) | ✅ (workspace instructions) | ✅ |
| `.cursor/rules/*.mdc` (17) tự nạp | ✅ | ⚠ nạp `.agents/rules/*.md` | ❌ **không nạp** — nhận qua `AGENTS.local.md` | ❌ — như desktop |
| `.cursor/agents/*-runtime.md` — 7 worker SLP | ✅ đọc + spawn | ✅ `.agents/agents/` + `invoke_subagent` | ⚠ đọc được, **không** có role registry ⇒ dùng skill `harness-engineering-team` | ⚠ như desktop |
| `.agents/skills/*/SKILL.md` | ✅ | ✅ (qua skill catalog) | ✅ (qua skill catalog) | ✅ (qua skill catalog) |
| MCP `codegraph` | ✅ | ✅ | ❌ **không có trong toolset** | ❌ |
| `codegraph` CLI (`--path`) | ✅ | ✅ | ✅ | ✅ **đo 2026-11-08** — `status`/`explore`/`query`/`context`/`node`/`files` |
| `docgraph` CLI | ✅ | ✅ | ✅ | ✅ **đo 2026-11-08** — `--q`, `--repo`, `--print-harness` |
| `agentmemory-mcp` | ✅ | ✅ (`call_mcp_tool` / eager tools) | ✅ **đo lại 2026-11-07**: `memory_smart_search` · `memory_save` · `memory_diagnose`, store **966** bản ghi | ❌ **profile `paseo` không mount** — bật bằng `node scripts/setup-paseo-profile.mjs` |
| `deepseek-direct` | ✅ | ✅ | ❌ **không có trong toolset** | ❌ |
| `.docgraph/` · `.codegraph/` trên đĩa | ✅ truy vấn được | ✅ truy vấn được | ✅ (qua CLI) | ✅ (qua CLI) |
| file tools · shell · `bun test` · subagent | ✅ | ✅ (`invoke_subagent`, `define_subagent`) | ✅ | ✅ |

**Luật suy ra:** quy trình recon dưới đây là **quy trình của Cursor**. Trên host không có MCP, bước recon **thay bằng**
`codegraph`/`docgraph` CLI (nếu có binary) rồi mới tới `grep`/`glob` + `read` có kiểm soát, và phải **nói rõ** khi một
kết luận dựa trên suy đoán thay vì tra cứu — vì thiếu tra cứu làm tăng khẳng định sai (đã xảy ra 3 lần trong một phiên).

**Đo lại 2026-11-07 (DSH):** dòng cũ gộp bốn MCP vào một ô và ghi ❌ cho **cả bốn** — sai với `agentmemory-mcp`. Host DSH có memory tools (đã gọi thật, store 966 bản ghi) nhưng **không** có codegraph/docgraph CLI. Tách dòng vì một ô gộp làm cả hai chiều cùng sai: agent bỏ qua memory (đúng ra phải dùng), và tưởng có codegraph (đúng ra không).

**Đo lại 2026-11-08 (DSH có nhiều profile — Paseo):** phép đo 2026-11-07 chạy trong profile **`desktop`**, nhưng được ghi
thành "DSH ✅" **không kèm tên profile**. Paseo spawn `dsh --profile paseo`, profile đó chỉ có `dsh-base` + `dsh-paseo-bridge`
⇒ **không một tool `memory_*` nào**. Cùng lúc, `codegraph`/`docgraph` **CLI chạy được** trong session Paseo (đã gọi thật) nên
ô "không có công cụ truy vấn" cũng sai. Luật: **mọi ô năng lực của DSH phải nêu profile**, và recon trong session Paseo dùng
CLI `--path "$PWD"` — xem `core.paseo-provider.mdc` + skill `paseo-recon`.

**Luật này áp cho mọi agent, không chỉ người viết nó:** gặp host chưa có trong bảng ⇒ **đo rồi bổ sung bảng**, không giả
định năng lực.

## Công cụ được dùng (bắt buộc khi cần)

Agent **được phép và nên** dùng các MCP / tool sau khi tra cứu code, doc, memory, hoặc cần reasoning nặng:

| Nguồn | Khi dùng | Gợi ý |
|--------|-----------|--------|
| **Codegraph** | Luồng gọi, symbol, blast radius trong **product** | MCP `codegraph` trong **`.cursor/mcp.json`** (index harness-eso). `codegraph_explore` · `projectPath` = root harness-eso; consumer-only → `../x79`. Không `.codegraph/` → `codegraph init -i` hoặc Read/Grep. |
| **Reply output** | Mọi câu trả lời | Rule `core.reply-format.mdc`: plain markdown, **không** bọc `{text,type}`. Detector `.cursor/hooks/lib/agent-response.mjs`; guard `stop` (`wrapped-output-guard.mjs`, `followup_message`) — `afterAgentResponse` **không có output field** nên chỉ để quan sát. Đo tỉ lệ thật: `node .cursor/hooks/audit-wrapped-replies.mjs --days 30`. Test `qc/output-wrapper.test.mjs`. |
| **Docgraph** | Kiến thức, tài liệu, invariants trong **product** (hoặc law x79) | Index cục bộ tại `.docgraph/` (scope: `docs/`, rules). Dùng CLI **`docgraph --q "<terms>"`**. Tra cứu consumer x79: truyền CLI `docgraph --q ... --repo ../x79`. |
| **AgentMemory** | Context phiên, preference operator | MCP **`agentmemory-mcp`** trong `.cursor/mcp.json` (`memory_smart_search` / `memory_save`). |
| **DeepSeek** | Phân tích sâu, thiết kế, debug khó | MCP **`deepseek-direct`** trong `.cursor/mcp.json`: **`ask_deepseek_flash`** (default), **`ask_deepseek_pro`** khi cần. |

**Brain tier:** quyết định ở đây (AGENTS.md). ESO preflight trên x79 chỉ gợi ý `brainTierHint`.

**Không thay thế:** sửa file vẫn dùng editor tools; shell khi cần `bun test`, docker, v.v.

---

## Thứ tự làm việc & Kỷ luật Token

1. **AgentMemory first (Tra cứu sớm):** Luôn gọi `memory_smart_search` ngay đầu turn để thu thập context phiên trước, ticket ID, symbol, file path và từ khóa then chốt. Dùng từ khóa này làm đầu vào chính xác cho Docgraph và Codegraph, tránh query mò mẫm làm tăng token.
2. **Khảo sát tài liệu (Docgraph first):** Tra cứu concept, invariant, contract bằng CLI `docgraph --q "<terms>"` để lấy đúng đoạn cần đọc (30–50 dòng). **Chỉ dùng `view_file` / `Read` khi Docgraph không trả về kết quả hoặc bắt buộc phải xem toàn văn file**.
3. **Khảo sát code (Codegraph first):** Dùng `codegraph_explore` (với `projectPath` = harness-eso) để lấy AST, call hierarchy và symbols mục tiêu trong 1 round-trip. **Chỉ dùng `Grep` + `Read` khi Codegraph thiếu thông tin hoặc cần quét regex cụ thể**.
4. **Kỷ luật Range-Read (Slice Reading):** Khi bắt buộc dùng `view_file` / `Read` cho file lớn (> 100 dòng), tuyệt đối không mở toàn bộ file vào context. Phải chỉ định rõ `StartLine` và `EndLine` (hoặc lệnh shell `sed -n 'X,Yp'`) để chỉ nạp đúng phân đoạn cần xử lý.
5. **Kỷ luật Shell Output (Bắt buộc giới hạn):**
   - Không chạy lệnh in ra output thô > 40 dòng vào context.
   - Luôn pipe giới hạn khi kiểm tra: `git status -s`, `bun test 2>&1 | tail -n 25`, `head -n 30`, `grep -m 10`.
   - Khi test pass chỉ cần tóm tắt kết quả (ví dụ `213 pass`).
6. **Implement & Test:** Sửa file gọn gàng, test cục bộ với output có kiểm soát.
7. **DeepSeek:** Chỉ gọi `ask_deepseek_flash` / `pro` khi cần suy luận kiến trúc phức tạp hoặc debug lỗi hóc búa — không gọi cho thay đổi 1–2 dòng rõ ràng.
8. **Distillation & Memory Save (Đóng gói tri thức):** Cuối mỗi turn xử lý logic quan trọng, gọi `memory_save` cô đọng quyết định, trạng thái và bài học. Giúp các turn kế tiếp kế thừa trực tiếp từ memory mà không cần đọc lại hàng loạt file cũ.


---

## SLP — chia việc khi task chạm >1 tầng

**Build enforcement law:** [`sdlc/02.governance/01.standard/09.build-enforcement.md`](sdlc/02.governance/01.standard/09.build-enforcement.md) — pack đủ 4 phần · test-first · gate máy · verify/audit độc lập · chỉ người ký `Done`. Không có ngoại lệ cho agent.

Request cần sửa nhiều package hoặc nhiều tầng ⇒ chạy **SLP**, không tự làm tuần tự.

| Thành phần | Ở đâu |
|---|---|
| Luật | `.cursor/rules/core.slp.mdc` (mirror `.agents/rules/core.slp.md`) |
| Thứ tự gate | skill **`harness-engineering-team`** — 9 gate đánh số |
| 7 worker | `.cursor/agents/{scout,plan,build,verify,audit,fixbug,qc}-runtime.md` (Cursor) · `.agents/agents/` (Antigravity) |
| Bằng chứng | scratch: `comments/artifacts/slp/{recon,plan,verify,audit}/` — **không cite**; proof thật là board receipts + gate + commit (`core.artifacts`) |

**Jira parent-child rollup:** sau mỗi child transition, chạy `node scripts/jira-rollup.mjs <STORY-KEY>` — child `In Progress` ⇒ Story `In Progress`; tất cả child `Human In Review`/`Done` ⇒ Story `Human In Review`; **không auto `Done`**. Rule: [`delivery.jira-agent-execution`](.agents/rules/delivery.jira-agent-execution.md).

**Bốn lớp:** **S** = người (duyệt plan · xử escalation · **ký `Done`** — không bao giờ là agent) · **L** = agent chat chính ·
**P** = `scout` · `plan` · `build` (mỗi slice) · `fixbug` · **A** = `verify` · `audit` · `qc` (độc lập, không sửa code sản phẩm).
`allowed_files` của 7 worker **rời nhau từng cặp** — kiểm bằng `qc/slp-conformance.test.mjs`.

**Thứ tự cứng:** build → verify PASS → audit **≥85 & 0 CRITICAL** → `Human In Review`; QC chỉ khi operator yêu cầu (`D-41`).
Cùng lỗi gốc **3** lần ⇒ dừng, liệt kê `OPEN`, escalate **lên người**. Không `Done`, không commit/push/PR trừ khi user yêu cầu.

Ticket nhỏ (1 file) ⇒ được làm inline, **vẫn** phải verify **và** audit. Luật đầy đủ: `core.slp.mdc` §2–§7.

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
  harness-observatory/     monitor UI (:8792 host, :8790 in-container)
  harness-cli/             observe, init profile
profiles/                  generic-eso.json, plugin-catalog, host superset
qc/                        node:test integration
console.sh                 deploy / lifecycle Console :8791 (root, cạnh deploy.sh)
*.Dockerfile               observe + console images (root)
docs/                      handover pack + operator guides — the only human-docs root; X28 keeps every reference honest
```

Adapter id trong policy (tham chiếu khi sửa core): `docgraph-cli`, `codegraph-cli`, `agentmemory-mcp`, brain `deepseek-mcp`.

---

## Lệnh dev (host có Bun)

```bash
bun install
bun test                              # qc/ only — bunfig sets [test] root="./qc"
bun run test                          # everything: qc + every packages/*/src suite
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
- **Không ghi tài liệu bền vào `comments/`** — đó là scratch: `gitignore` cả thư mục, người vận hành sẽ xoá bất cứ lúc nào. Thiết kế/reference → `docs/<NN.topic>/` · luật/quyết định → `sdlc/` · tạm trong phiên → `/tmp` (ngoài repo). Luật đầy đủ: `.cursor/rules/core.artifacts.mdc` · `.agents/rules/core.artifacts.md`.
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
