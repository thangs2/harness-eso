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
([naming law](02.governance/01.standard/02.artifacts.md) §4.1). Ở cấp `sdlc/` chỉ có folder, nên đây là **một** dãy — liền
mạch, **không trùng số**, và **không mang nghĩa "stage"**.

```text
01.agent-manifests   meta — vùng AI: spec domain + 9 capability (≤150 dòng · ≤4 000 ký tự)
02.governance        meta — luật: SoT · chuẩn SDLC · cổng · register (tiếng Anh)
03.inception         vì sao tồn tại · quyết định
04.landscape         bối cảnh: đứng ở đâu, ai cho gì, chỗ không chơi
05.requirements      phải LÀM được gì (kiểm chứng được)
06.analysis          actor · use case · US · AC · scenario (stage 2 + 3)
07.technical         **kỹ thuật, một cửa** — đọc theo độ sâu:
    01.architecture    cấu trúc: C4 · trục · seam · nơi phán quyết chạy   (cao)
    02.data-design     lưu trữ: entity · schema · RLS · định dạng decl.   (giữa)
    03.api             hợp đồng: endpoint · payload · lỗi · idempotency   (thấp)
08.ui-design         **thiết kế giao diện** — chuẩn riêng (Figma · Penpot · guideline)
09.wbs               WBS duy nhất — Feature → Epic → Story → Task
10.test              phép thử nói "done" nghĩa là gì
```

**Vì sao `07.technical` là một nhóm, không phải ba folder:** C4 → data → API là **một chuỗi lập luận** — container tồn tại, nó lưu
một dòng, nó nhận dữ liệu qua một endpoint. Ba folder rời buộc người đọc **đoán** folder nào sở hữu câu hỏi, mà đáp án thường là
**cả ba**.

**Vì sao `08.ui-design` **ngoài** nhóm đó:** UI theo **chuẩn thiết kế riêng** (Figma · Penpot · guideline) và **không** trả lời
"các phần gọi nhau thế nào". Gộp UI vào technical là trộn **hợp đồng** với **trình bày**.

**`stage` không phải số folder.** Stage sống trong frontmatter `phase` của từng tài liệu. Folder là **thứ tự đọc**; stage là
**thuộc tính của tài liệu** — nên `06.analysis` vẫn khai `phase: 2`.

### API ≠ UI — hai tài liệu, hai người đọc

| | Ở đâu | Trả lời |
|---|---|---|
| **API spec** | `07.technical/03.api/` | máy gọi nhau thế nào: endpoint · payload · mã lỗi · idempotency — **kỹ thuật** |
| **UI/UX design** | `08.ui-design/` | người nhìn thấy gì: bề mặt · màn hình · luồng — **thiết kế** |

Gộp hai thứ này vào một folder là trộn **hợp đồng** với **trình bày**: API đổi vì lý do kỹ thuật, UI đổi vì lý do sử dụng, và
không cái nào được kéo cái kia đi.

### Bỏ trống có chủ ý

`13.change` · `14.delivery` · `15.operations` — thêm **khi có nội dung thật**, không tạo folder rỗng.

