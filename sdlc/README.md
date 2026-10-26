# SDLC — harness-eso

**`sdlc/` là working tree của sản phẩm.** Người và agent đọc và ghi ở đây. Nó **không** thay
`documents/`.

```text
documents/     sản phẩm LÀ gì, và chạy thế nào (reference — mô tả trạng thái code)
sdlc/          sản phẩm ĐANG ĐI ĐÂU, và vì sao (direction — định hướng, quyết định, WBS)
```

Hai trục. `documents/` mô tả **hiện tại**; `sdlc/` nói **kế tiếp**. Một câu ở đây mô tả code phải cite
được file trong `packages/`; nếu chỉ là mong muốn thì nó thuộc `03.inception/`, không thuộc `documents/`.

## Đối tượng độc giả

**Sản phẩm:** `harness-eso` — monorepo ship package `@mu/harness-*`.

`sdlc/` nói về **sản phẩm**. Consumer (`x79`, `atrievefin`, `fineso`, `baplatform`) là **nơi thụ hưởng**;
chúng xuất hiện ở đây chỉ khi cần làm ví dụ để kiểm chứng một phát biểu về sản phẩm, **không** phải đối
tượng ta đang xây. Việc của consumer thuộc SDLC của chính consumer đó.

## Cấu trúc — **hai không gian tên độc lập**

**Folder** đánh số `01…` **chỉ trong folder**; **file** đánh số `01…` **chỉ trong file**
([naming law](./02.governance/01.standard/02.artifacts.md) §4.1). Ở cấp `sdlc/` chỉ có folder, nên đây là **một** dãy — liền
mạch, **không trùng số**, và **không mang nghĩa "stage"**.

```text
01.agent-manifests   vùng AI: spec cho domain + 9 capabilitiy (≤150 dòng · ≤4 000 ký tự)
02.governance        luật của tree: SoT · chuẩn SDLC · cổng · register (tiếng Anh)
 → 03.inception      vision · mission · goals · decisions — vì sao tồn tại, đi đâu
 → 04.landscape      bối cảnh: sản phẩm đứng ở đâu, ai cho gì, chỗ ta không chơi
 → 05.requirements   sản phẩm phải LÀM được gì (phát biểu kiểm chứng được)
 → 06.analysis       actor · use case · user story · AC · scenario matrix
 → 07.architecture   mô hình kỹ thuật: trục, bề mặt, seam, provider, graph (C4)
 → 08.data-design    entity · quan hệ · schema Postgres · RLS · định dạng declaration
 → 09.api            **hợp đồng API (kỹ thuật)**: endpoint, vào/ra, lỗi, idempotency
 → 10.ui-design      **thiết kế giao diện (UI/UX)**: bề mặt, màn hình, luồng cho người
 → 11.wbs            WBS duy nhất — Feature → Epic → Story → Task
 → 12.test           phép thử nói lên "done" nghĩa là gì
```

**`stage` không phải số folder.** Stage sống trong frontmatter `phase` của từng tài liệu. Folder là **thứ tự đọc**; stage là
**thuộc tính của tài liệu** — nên `06.analysis` vẫn khai `phase: 2`.

### API ≠ UI — hai tài liệu, hai người đọc

| | Ở đâu | Trả lời |
|---|---|---|
| **API spec** | `09.api/` | máy gọi nhau thế nào: endpoint · payload · mã lỗi · idempotency — **kỹ thuật** |
| **UI/UX design** | `10.ui-design/` | người nhìn thấy gì: bề mặt · màn hình · luồng — **thiết kế** |

Gộp hai thứ này vào một folder là trộn **hợp đồng** với **trình bày**: API đổi vì lý do kỹ thuật, UI đổi vì lý do sử dụng, và
không cái nào được kéo cái kia đi.

### Bỏ trống có chủ ý

`13.change` · `14.delivery` · `15.operations` — thêm **khi có nội dung thật**, không tạo folder rỗng.

