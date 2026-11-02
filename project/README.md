---
sot_doc_version: "0.1.0"
source_of_truth: "standard/08.sections.md"
status: DRAFT
phase: 1
id: PROJECT-README
type: instance
---

# `project/` — **Section A**: cách repo này tự chạy

> Luật phân biệt A/B: [`08.sections`](../standard/08.sections.md). Bản khai của repo: [`04.instance`](01.governance/04.instance.md).

**A là về _chúng ta_**, không phải về sản phẩm. Consumer **không nhận** thư mục này — họ nhận `standard/` và `docs/` (Section B),
cộng với bản khai instance của **chính họ**, do control plane sinh ra.

| # | Folder | Giữ gì | Trước đây |
|---|---|---|---|
| 01 | [`01.governance/`](01.governance/README.md) | trạng thái tài liệu · register `OPEN` · phân tích · **bản khai instance** | `sdlc/02.governance` |
| 02 | [`02.wbs/`](02.wbs/00.index.md) | WBS · 45 `BIP` · 7 `FIP` — kế hoạch **công việc của chúng ta** | `sdlc/09.wbs` |
| 03 | [`03.test/`](03.test/00.index.md) | **"done" nghĩa là gì** — tiêu chí nghiệm thu ở mức sản phẩm | `sdlc/10.test` |

## Vì sao tách khỏi `sdlc/`

`sdlc/` là **Section B** — đặc tả sản phẩm, thứ được ship. Nhưng nó đang chứa cả `02.governance` (trạng thái của **ta**),
`09.wbs` (kế hoạch của **ta**), `10.test` (định nghĩa done của **ta**).

> **Hệ quả cụ thể:** nếu đưa `sdlc/` cho consumer, họ nhận luôn **status register và WBS của chúng ta**. Đó không phải tài liệu
> tham khảo — nó là bản ghi nội bộ, và nó sẽ mục ngay khi tách khỏi ngữ cảnh.

## Đánh số: `sdlc/` có lỗ, và đó là **có chủ ý**

`sdlc/` còn `01` · `03` · `04` · `05` · `06` · `07` · `08` — thiếu `02`, `09`, `10` vì chúng đã chuyển sang đây. Đánh số lại để
liền mạch sẽ chạm **763 tham chiếu** cho một lợi ích bằng không: số folder là **khoá**, không phải thứ tự.

Luật vì thế được sửa: **dãy gapless, trừ khi có dời đã ghi lại** — và lỗ phải được nêu ở đây, không để người sau tự đoán.
