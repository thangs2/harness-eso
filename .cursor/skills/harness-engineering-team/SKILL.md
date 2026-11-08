---
name: harness-engineering-team
description: Runs one harness-eso ticket through SLP — scout, plan, disjoint slices, build peers, verify, audit rubric (>=85, 0 CRITICAL), QC. Use when a request touches more than one package or layer. Lead-facing procedure; the law is core.slp.mdc.
---

# harness-engineering-team

**Bạn là Lead.** Skill này là **thứ tự**; **luật** là `.cursor/rules/core.slp.mdc` (Cursor) — trên host không nạp rules (DSH) thì
các mục §1–§4 dưới đây là bản tối thiểu bắt buộc.

Worker: `.cursor/agents/*-runtime.md` (Cursor) / `.agents/agents/*-runtime.md` (Antigravity) (**7**). Blackboard DAG: worker chỉ nói với Lead (Antigravity: `invoke_subagent`).

## 0. Dùng khi

Ticket/key `ESO-*` cần >1 file hoặc >1 tầng. **Không** dùng cho câu hỏi, typo, sửa một dòng (nhưng vẫn phải verify + audit).

## 1. Bốn lớp

**S** = người (duyệt plan · xử escalation · ký `Done`) · **L** = bạn · **P** = `scout` `plan` `build` `fixbug` · **A** = `verify`
`audit` `qc`. S **không bao giờ** là agent; gate **không** sửa code sản phẩm.

## 2. Hợp đồng prompt — luôn 4 phần

`INV ids` · `AC rows in scope` · `allowed_files` · `verify command`. Thiếu ⇒ worker hỏi lại, **không đoán**.

## 3. Trả về — mỗi worker một JSON có kiểu

| Worker | Trả về |
|---|---|
| `scout` | `domains[]` `inv[]` `touched_files[]` `open_gaps[]` `risks[]` (≤300 từ) |
| `plan` | `slices[]`: `id` `role` `ac[]` `inv[]` `allowed_files[]` `depends_on[]` `verify` |
| `build` | `status` `DONE\|BLOCKED_SCOPE` · `files_changed[]` `tests_added[]` |
| `verify` | `status` PASS/FAIL · `commands_run[]` · `failure_log` |
| `audit` | `verdict` · `score` · `critical[]` · `findings[{file,line,rule,fix}]` · `ac_coverage{}` |
| `qc` | `status` · `failed_gates[]` · `scenarios_run[]` · `residual_open[]` |

JSON có kiểu là mấu chốt: bạn **ghép** được mà không đọc văn xuôi, và `findings[].file:line` cho `fixbug` việc **không cần hỏi lại**.

## 4. Luật cứng

1. Slice `allowed_files` **rời nhau** — chồng = plan không hợp lệ, chia lại.
2. Ghi ngoài slice ⇒ `BLOCKED_SCOPE`, dừng.
3. Zero-crawl: peer nhận pack trong prompt, không đọc `sdlc/01…09`.
4. Cùng lỗi gốc **3** lần ⇒ dừng, liệt kê `OPEN`, escalate **lên người**.
5. Không `Done`, không commit/push/PR trừ khi S yêu cầu.
6. Codegraph/docgraph thiếu ⇒ nói ra + fallback; **không** claim success.

## 5. Thứ tự gate — đánh số, không nhảy

1. **Classify** — `product` (`packages/*`) · `law/spec` (`sdlc/`, spec x79) · `E2E` (consumer x79). Prompt lẫn lộn ("implement" mà
   không có key/slice) ⇒ **hỏi hoặc REWORK**, không đoán AC.
2. **Pack** — ticket + domain spec (`sdlc/01.agent-manifests/01.domains/`) + AC + **một** verify command. Chưa đủ ⇒ spawn `scout`
   **trước**; chưa có pack thì **không** spawn `build`.
3. **Session** — `AGENTS.md` đã Read; MCP/brain theo `core.harness-tooling.mdc`. Thiếu công cụ ⇒ ghi rõ, không giả định.
4. **Plan** — spawn `plan`. **S-GATE 1** khi >1 tầng hoặc scope mơ hồ: đưa bảng slice cho S duyệt.
5. **Build × N** — spawn một `build` mỗi slice (trên DSH Lead: gọi CLI `agy -p "..." --agent build-runtime`); song song khi `depends_on` rỗng.
6. **Verify** — spawn `verify` với **đúng** lệnh của Task (`bun test` trong package · `bun run test` · UI: `build:observatory` +
   `test:observatory`). FAIL ⇒ sang 7.
7. **Audit** — spawn `audit` trên diff. `AUDIT_FAIL` ⇒ `fixbug` ↺ về 6. **3** vòng ⇒ **S-GATE 2**.
8. **Human In Review** — Lead ghi comment + nhãn + rollup. **Không** `Done`: quyền đó của S.
9. **QC** — khi operator yêu cầu: spawn `qc` (scenario → `qc/`). **S-GATE 3**: S ký `Done`.

## 6. Rubric `audit` (tóm tắt — chi tiết trong rule §6)

`30` deterministic green · `30` bất biến (`docs/05.development/02.invariants.md`, không tái sinh bug register §3) · `25` AC đủ +
không hợp đồng tự chế · `15` kỷ luật biên. **CRITICAL** (INV · nguồn sự thật thứ hai · API tự chế · fake green) ⇒ FAIL bất kể điểm.

## 7. Chọn slice (mặc định, theo tầng)

`pkg-foundation` → `pkg-core` (`eso-core`, `decision`, `system-one`) → `pkg-host` → `pkg-observe` (`observe-server`, `cli`) →
`pkg-ui` (`observatory`, `console`) · `pkg-qc` (`qc/`) · `law-docs` (**Lead/người**, không giao peer).

V2 (`eso/<domain>/**`) dùng **thẳng** `allowed_files` của domain spec.

## 8. Bằng chứng cuối lượt

`class` · pack đã đọc · codegraph/docgraph status · lệnh verify + log · `audit` score/verdict · slice + file đã ghi ·
`memory_save` nếu có quyết định. Thiếu ⇒ **không** nói "đã xong".

## 9. Một lượt, viết gọn

```text
Lead: pack ESO-… → plan → S1(pkg-core) ∥ S2(pkg-ui) → verify(PASS) → audit(91, 0 CRITICAL) → HIR
      nếu audit fail: fixbug(findings) → verify ↺ (loop 2/3)
```
