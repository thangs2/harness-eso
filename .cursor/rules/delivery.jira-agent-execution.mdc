---
description: Jira parent-child status rollup — child In Progress ⇒ Story In Progress; all children Human In Review/Done ⇒ Story Human In Review; never auto Done.
layer: delivery
globs: "sdlc/09.wbs/**/*,scripts/jira-*,qc/jira-*"
alwaysApply: false
version: "1.0.0"
---

# Jira — parent/child status rollup (ESO)

**Nguồn:** [`sdlc/07.technical/01.architecture/17.jira-slp-operating.md` §6.1](../../sdlc/07.technical/01.architecture/17.jira-slp-operating.md)
· baplatform `sdlc/00.governance/05.operating-model/05.jira/04.story-subtask-rollup.md`.

Jira **không** tự sync Story khi Task/Subtask đổi. Sau **mỗi** child transition, người chuyển (agent/Lead) phải tính lại
Story trong **cùng session**; không đợi cuối batch.

## Luật

| Child pattern | Story transition |
|---|---|
| **Bất kỳ** con `In Progress` | Story → **In Progress** (kể cả đang HIR — rework mở lại) |
| **Tất cả** con `Human In Review`/`Done` | Story → **Human In Review** |
| Hỗn hợp HIR/Done + còn `To Do`/Backlog | Story → **In Progress**, không HIR |
| Tất cả con `To Do`/Backlog | Không đổi (không kéo Story về sau) |
| Không có con / status lạ | Không đổi; ghi `OPEN`, không đoán |

**Cấm:** agent set Story `Done`/`Closed`; reopen Story `Done`/`Closed`; chuyển Story sang HIR khi còn con `To Do`/`In Progress`.

## Cách làm

1. Đọc Story + direct children từ Jira MCP/API.
2. Chạy `node scripts/jira-rollup.mjs <STORY-KEY>` (dry-run).
3. Nếu target đúng, chạy lại với `--apply`.
4. Comment lên Story: child statuses + target; giữ `ESO-405` là ví dụ.
5. Nếu script không có transition tới target: dừng, comment `OPEN`, không sửa status tay.

**Không** sync WBS markdown trừ khi người yêu cầu. Jira là live SoT.
