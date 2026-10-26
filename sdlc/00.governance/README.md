# 00 — Governance

Luật của tree này. Ngắn, và chỉ chứa thứ sẽ bị vi phạm nếu không viết ra.

| # | Folder / file | Vai trò |
|---|---|---|
| 01 | [`01.source-of-truth/`](./01.source-of-truth/) | cái gì được cite, cái gì là SoT · **cổng giai đoạn** |
| 02 | [`02.sdlc-workflow.md`](./02.sdlc-workflow.md) | **quy trình SDLC**: 8 stage · 4 plane · ba loại tài liệu · C4 ladder · BIP/FIP · thứ tự phase |
| 03 | [`03.sdlc-standard/`](./03.sdlc-standard/00.index.md) | **CHUẨN SDLC (normative)**: dấu `OK/P/OUT/—` · trạng thái `READY/READY-SPLIT/BLOCKED` · **hình dạng 16 loại tài liệu** · BIP/FIP |
| 04 | [`04.open-register.md`](./04.open-register.md) | **register `OPEN`**: **4 câu** chặn Stage 4–5 · **5 câu đã có đáp án** (cite, không hỏi lại) |
| 05 | [`05.document-status.md`](./05.document-status.md) | **ma trận kiểm tài liệu**: mỗi hạng mục (#1…) đã có gì · **nợ** gì · thứ tự làm |
| 06 | [`06.quality-gate/`](./06.quality-gate/00.index.md) | **cổng (1:1 với BAP `03.quality-gate/`)**: `01` lifecycle · `02` pre-flight · `03` go/no-go · `05` gate-flow |

`documents/` là law của **hiện trạng** (invariant, defect register, feature map). `sdlc/` được quyền ghi,
nhưng không được mâu thuẫn với `documents/`. Nếu mâu thuẫn: `documents/` mô tả đúng code, `sdlc/` phải sửa
hoặc mở một `D` để đổi hiện trạng.
