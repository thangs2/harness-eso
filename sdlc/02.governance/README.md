---
sot_doc_version: "0.1.0"
source_of_truth: "sdlc/README.md"
status: DRAFT
phase: 1
id: GOV-README
type: standard
---

# `02.governance` — bản ghi quản trị của **dự án này**

> **Luật không ở đây nữa.** Chuẩn SDLC đã tách sang [`standard/`](01.standard/00.index.md) — nó là **sản phẩm**, ship cùng
> harness-eso, và consumer **trỏ tới** chứ không nhận bản sao. Lý do: [`04.folders`](../03.inception/03.artifact-model/04.folders.md).
>
> Folder này giữ **bản ghi của chính dự án**: trạng thái tài liệu, mục còn treo, và một phân tích. Đây là **instance**, không
> phải chuẩn — nó được kiểm, không phải để kiểm người khác.

**Two independent number sequences.** Folders `01…` and files `01…` are numbered **separately** — a folder number says nothing
about a file number. Mixing them (`01.file` · `02.file` · `03.folder`) is forbidden ([naming law](01.standard/02.artifacts.md) §4).

## Files

| # | File | Role |
|---|---|---|
| 01 | [`01.document-status.md`](01.document-status.md) | **trạng thái tài liệu**: "documented" nghĩa là gì · **47 phép kiểm** · instance đo được |
| 02 | [`02.open-register.md`](02.open-register.md) | **register `OPEN`**: câu hỏi về hình dạng chưa có đáp án, mỗi câu kèm đề xuất |
| 03 | [`03.x7-analysis.md`](03.x7-analysis.md) | phân tích `X7` — vì sao kiểm hình dạng theo `type` lại cần |
| 04 | [`04.agent-rules.md`](04.agent-rules.md) | **10 luật cho agent** — mỗi luật kèm lỗi đã sinh ra nó |

`README.md` is the only unnumbered file here — it is **navigation**, not an artifact.

**Ba tầng, ba vai.** `standard/` nói điều gì phải **đúng**; `sdlc/` ghi điều **đang là**; `qc/` là **máy kiểm** đối chiếu hai
cái đó. Không luật nào bị chép vào bản ghi, và không bản ghi nào tự phát minh luật.

`docs/` là luật của **trạng thái hiện tại** (invariants, defect register, feature map). `sdlc/` được viết, nhưng không được
mâu thuẫn với `docs/`. Khi xung đột: `docs/` mô tả code đang làm gì, nên `sdlc/` phải đổi — hoặc mở một `D` để đổi
trạng thái hiện tại.
