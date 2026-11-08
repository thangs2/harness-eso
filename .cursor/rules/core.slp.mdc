---
description: SLP — Supervisor/Lead/Peer/Gate, 7 worker runtime, disjoint slices, rubric >=85, typed JSON returns
layer: core
alwaysApply: false
version: "1.0.0"
canonical: AGENTS.md
globs: packages/**,qc/**,.cursor/agents/**,.agents/agents/**,comments/artifacts/slp/**,sdlc/01.agent-manifests/**
---

# SLP — cách chia việc trong repo này

**Prerequisite:** `core.law-gate.mdc` (đã **Read** `AGENTS.md`). Rule này **không** thay `AGENTS.md`; nó là **cơ chế phân việc**
khi một yêu cầu cần hơn một lượt sửa. Skill chạy: `harness-engineering-team` (`.cursor/skills/` · `.agents/skills/`). Worker:
`.cursor/agents/*-runtime.md` (Cursor) · `.agents/agents/*-runtime.md` (Antigravity) (**7**).

> Nguồn: đo trên **baplatform** (`.cursor/agents/`, 7 role) — `sdlc/07.technical/01.architecture/16.jira-ticket-contract.md` §10
> và `17.jira-slp-operating.md`. Phần **giữ**, phần **đổi cho ESO** ghi ở §8 của `17`; rule này là bản thi hành.

## 1. Bốn lớp — ai được làm gì

| Lớp | Là ai | Gates |
|---|---|---|
| **S** Supervisor | **người** (operator), **ngoài** vòng lặp | duyệt plan khi scope lớn/mơ hồ · xử escalation · **ký `Done`** |
| **L** Lead | agent chat chính | đọc pack · chia slice · spawn worker · ghi `Human In Review` · rollup |
| **P** Peer | `scout` · `plan` · `build` (một slice/lần) · `fixbug` | không crosstalk; `allowed_files` **rời nhau** |
| **A** Gate | `verify` (deterministic) · `audit` (rubric) · `qc` (scenario) | độc lập với builder; **không** sửa code sản phẩm |

**S không bao giờ là agent.** Một agent tự ký `Done` là một quy trình giả.

## 2. Bảy worker — `allowed_files` **rời nhau từng cặp**

| Worker | `allowed_files` (ghi) | Đọc | Trả về |
|---|---|---|---|
| `scout` | `comments/artifacts/slp/recon/` | `sdlc/01.agent-manifests/01.domains/`, `packages/` | `domains[]` · `inv[]` · `touched_files[]` · `open_gaps[]` · `risks[]` (**≤300 từ, không code**) |
| `plan` | `comments/artifacts/slp/plan/` | domain spec · `sdlc/09.wbs/` | `slices[]`: `id` · `role` · `ac[]` · `inv[]` · `allowed_files[]` · `depends_on[]` · `verify` |
| `build` | `packages/` — **chỉ** slice được giao | slice + AC rows | `slice` · `status` `DONE\|BLOCKED_SCOPE` · `files_changed[]` · `tests_added[]` |
| `fixbug` | **derived** — `findings[].file`, ⊆ slice đang FAIL | audit JSON / failure log | `status` · `root_cause` · `fix[]` |
| `verify` | `comments/artifacts/slp/verify/` | lệnh verify của Task | `status` PASS/FAIL · `commands_run[]` · `failure_log` |
| `audit` | `comments/artifacts/slp/audit/` | `git diff` · INV · AC | `verdict` · `score` · `critical[]` · `findings[{file,line,rule,fix}]` · `ac_coverage{}` |
| `qc` | `qc/` | scenario matrix | `status` · `failed_gates[]` · `scenarios_run[]` · `residual_open[]` |

**Luật:** giao của **hai tập `allowed_files` bất kỳ** = ∅ — `qc/slp-conformance.test.mjs` so **từng cặp**. `fixbug` **không** có
tập tĩnh: nó chỉ được ghi đúng file mà `audit.findings[].file` / failure log nêu, và file đó phải nằm trong slice đang FAIL.
Mọi đường khác ⇒ `BLOCKED_SCOPE`, dừng, báo Lead.

**Vì sao `build` giữ `packages/` còn `qc` giữ `qc/`:** unit test **colocated** sống cạnh code (`packages/*/src/*.test.mjs`) — đó là TDD
của chính builder. Scenario tích hợp ở `qc/` là **kênh khác**: builder tự viết scenario rồi tự chấm là **tự chấm điểm**.

**Vì sao gate chỉ ghi vào `comments/artifacts/slp/`:** gate **trả JSON**, Lead ghép. `comments/artifacts/` là chỗ bằng chứng của
một phiên (không phải tài liệu) — nên gate không tạo ra **nguồn sự thật thứ hai** (§A1).

## 3. Hợp đồng prompt — **luôn 4 phần**

`INV ids` · `AC rows in scope` · `allowed_files` · `verify command`.

Thiếu một phần ⇒ worker **hỏi lại**, **không đoán**. `plan` phát ra đúng 4 phần cho từng slice; Lead chuyển **nguyên văn**.

## 4. Luật cứng

1. **Blackboard DAG** — worker chỉ nói với Lead. Không worker-to-worker, không group chat.
2. **Slice rời nhau** — chồng `allowed_files` = plan **không hợp lệ**, chia lại. Ghi ngoài slice ⇒ `BLOCKED_SCOPE`.
3. **Zero-crawl** — peer nhận pack trong prompt; **không** đọc `sdlc/01…09` để tự dựng lại ngữ cảnh.
4. **Thứ tự gate** — build → verify PASS → `AUDIT_PASS` (**≥85**, **0 CRITICAL**) → `Human In Review`. QC **chỉ** khi operator yêu cầu.
5. **Trần vòng lặp** — cùng một lỗi gốc **3** lần ⇒ dừng, liệt kê `OPEN`, escalate **lên S** (không lên agent khác).
6. **Không tự chấm** — `verify`/`audit`/`qc` không sửa code; `build`/`fixbug` không tuyên bố PASS cuối.
7. **Không `Done`, không commit/push/PR** trừ khi S yêu cầu. Không `In Progress` hộ ticket người khác. Sau mỗi child transition, rollup parent: child `In Progress` ⇒ parent `In Progress`; tất cả child `Human In Review`/`Done` ⇒ parent `Human In Review`; không auto `Done` (rule: `delivery.jira-agent-execution`).
8. **Ticket nhỏ** — Lead được làm **inline** (không spawn) nhưng **vẫn** chạy verify **và** audit.
9. **Trung thực khi thiếu** — codegraph/docgraph không có ⇒ nói ra + fallback `grep`/`read`; MCP Brain down ⇒ `BRAIN_UNAVAILABLE`,
   dừng. **Không** claim success.

## 5. Gate — đánh số

| # | Gate | Vào | Ra |
|---|---|---|---|
| 1 | **Intake** | yêu cầu | `class`: `product` (`packages/*`) · `law/spec` (`sdlc/`, spec x79) · `E2E` (consumer x79) |
| 2 | **Pack** | ticket/key | ticket + domain spec + AC + verify command (chưa đủ ⇒ spawn `scout`, không tự đoán) |
| 3 | **Session** | — | law đã Read · MCP/brain theo `core.harness-tooling.mdc` |
| 4 | **Plan** — **S-GATE 1** khi >1 tầng hoặc scope mơ hồ | pack | bảng slice, `allowed_files` **rời nhau**, mỗi AC → đúng **một** slice |
| 5 | **Build × N** | slice | `DONE` hoặc `BLOCKED_SCOPE`; song song khi `depends_on` rỗng |
| 6 | **Verify** | slice đã build | PASS/FAIL + log **nguyên văn**; FAIL ⇒ `fixbug` ↺ |
| 7 | **Audit** | verify PASS | rubric §6; FAIL ⇒ `fixbug` ↺; **3** vòng ⇒ **S-GATE 2** |
| 8 | **Human In Review** | AUDIT_PASS | comment + nhãn + rollup. **Không** `Done` |
| 9 | **QC** | operator yêu cầu | matrix PASS/FAIL/BLOCKED — **S-GATE 3**: người ký `Done` |

## 6. Rubric `audit` — 4 tiêu chí

| Điểm | Tiêu chí | Đo bằng |
|---:|---|---|
| 30 | **Deterministic green** | `verify` PASS **trong phiên này**; mọi package bị chạm xanh; UI chạm ⇒ `bun run build:observatory` + `bun run test:observatory` xanh |
| 30 | **Bất biến** | không vi phạm `docs/05.development/02.invariants.md` (§A1 một nguồn · A2 `sot` **không** phải enforcement · A3 resolve tool identity · A4 hash đúng body) · không tái sinh bug `09.gate-defect-register.md` §3 · **không đổi ngưỡng trong code** · **không** mặc định thay `unknown` |
| 25 | **AC đủ, không hợp đồng tự chế** | mọi AC trong scope có test; route/field mới phải trích từ `docs/03.state-and-contracts/` hoặc spec `02.harness-eso` của x79 |
| 15 | **Kỷ luật biên** | chỉ sửa trong `allowed_files` của slice; gate không ghi vào `packages/` |

**CRITICAL** (vi phạm INV · **nguồn sự thật thứ hai** · API tự chế · **fake green**) ⇒ tiêu chí 2 = **0**, verdict **FAIL**
**bất kể** tổng điểm. Một lỗi CRITICAL không được **trung bình hoá** bằng điểm cao ở chỗ khác.

## 7. Lệnh verify theo tầng — **dev, không phải operator**

| Chạm | Lệnh |
|---|---|
| `packages/<pkg>/` | `cd packages/<pkg> && bun test` |
| nhiều package · `qc/` | `bun run test` |
| `harness-observatory`, `harness-console` | `bun run test:observatory` · `bun run build:observatory` |
| hành vi consumer (**x79**) | `./verify-consumer.sh <id>` · `./deploy.sh <id>` · `./provision.sh <id>` — **chỉ** qua entrypoint |

`bun test` là **dev**: nó **không** phải bước operator nên **không** vi phạm `core.entrypoints.mdc`. Ngược lại, đụng consumer thì
**chỉ** bốn script. Lệnh verify **đến từ Task/ticket**, không tự nghĩ ra; ticket thiếu lệnh ⇒ `FAIL`, `MISSING_VERIFY_PLAN`.

## 8. Bằng chứng — sáu thứ phải trưng ra

`class` · pack đã đọc · codegraph/docgraph **status** · lệnh verify + log · `audit` **score/verdict** · slice + file đã ghi.
Thiếu bằng chứng ⇒ **không** được nói "đã xong". Xem thêm `core.harness-agents.mdc` và `harness-engineering-team`.

## 9. Ba thứ **không** chép từ BAP

| BAP | ESO | Vì sao |
|---|---|---|
| `[be]` `[fe]` `[mo]` `[qc]` | **bỏ `[mo]`**; giữ `[be]` `[fe]` `[qc]` | không có mobile |
| QC chỉ chạy khi UT/COV/DEV `Done` (G-QC-06/07/08) | **QC chạy khi operator yêu cầu** (`D-41`) | một người: chờ `Done` là chờ lịch của chính mình |
| `dotnet build/test/format` | `bun test` · `bun run test` · `bun run build:observatory` | stack khác |

**Còn lại giữ nguyên:** quartet `tdd-unit`/`tdd-impl`/`tdd-coverage`/`tdd-qc` · link graph `Blocks`/`Relates` · Purpose P-01…P-07 ·
anti-pattern J-01…J-17 · WBS atomic "một subtask = một file hoặc một lệnh".

## 10. `READY` là **plan-ready**, không phải **tested** — `D-81`

Thứ tự **cứng**, không được đảo:

```text
BA AC → QC soạn SCN (sdlc/06.analysis/04.quality-control, trạng thái `planned`)
      → packet §7 AC → SCN → RED/GREEN → §9 READY
      → tdd-unit (RED) → tdd-impl (GREEN) → tdd-coverage → tdd-qc CHẠY SCN + RTM
```

Packet `READY` mà §9 đòi *"`SCN` đã chạy"* là **đảo thứ tự** và tự khoá: `bun test` đỏ trước khi có code. Plane `E` chỉ ghi
`OK` / `OK — một phần` / `OPEN` / `OUT` — **không** ghi tiến độ chạy. Máy kiểm: `qc/sdlc-wbs.test.mjs`. Quyết định:
`sdlc/03.inception/02-decision-log/06.architecture-va-data.md` `D-81`.

## 11. Multi-Provider Binding (DSH Lead & Gate, AGY Peer)

Khi chạy phân vai giữa **DeepSeek Harness (DSH)** và **Antigravity (AGY)**:
1. **DSH đảm nhiệm Lead & Gate**:
   - **Lead (L)**: Phân tích bài toán, chạy `plan-runtime` chia Slices độc lập, kiểm soát S-GATE 1 (Operator duyệt plan).
   - **Gate & QC (A)**: Chạy lệnh verify bằng máy (`bun test`), thực thi `audit-runtime` chấm rubric độc lập (≥85 điểm, 0 CRITICAL), và chạy kịch bản `qc-runtime` khi được yêu cầu.
2. **AGY đảm nhiệm Peer (P)**:
   - DSH **không trực tiếp sửa code sản phẩm** khi được giao vai trò Lead.
   - Với mỗi slice sau khi được duyệt, DSH dùng tool bash gọi AGY CLI (`agy`) để build:
     ```bash
     agy -p "<prompt 4 phần: INV, AC, allowed_files, verify command>" \
       --agent build-runtime \
       --dangerously-skip-permissions \
       --output-format json
     ```
   - AGY nhận prompt hợp đồng 4 phần và chỉ sửa trong `allowed_files` của slice đó.
3. **Thỏa mãn bất biến SLP**: Builder (AGY) và Gate (DSH) là hai thực thể độc lập — builder không bao giờ tự chấm điểm code của mình.

