# SDLC — harness-eso

**`sdlc/` là working tree của sản phẩm.** Người và agent đọc và ghi ở đây. Nó **không** thay
`documents/`.

```text
documents/     sản phẩm LÀ gì, và chạy thế nào (reference — mô tả trạng thái code)
sdlc/          sản phẩm ĐANG ĐI ĐÂU, và vì sao (direction — định hướng, quyết định, WBS)
```

Hai trục. `documents/` mô tả **hiện tại**; `sdlc/` nói **kế tiếp**. Một câu ở đây mô tả code phải cite
được file trong `packages/`; nếu chỉ là mong muốn thì nó thuộc `01.inception/`, không thuộc `documents/`.

## Đối tượng độc giả

**Sản phẩm:** `harness-eso` — monorepo ship package `@mu/harness-*`.

`sdlc/` nói về **sản phẩm**. Consumer (`x79`, `atrievefin`, `fineso`, `baplatform`) là **nơi thụ hưởng**;
chúng xuất hiện ở đây chỉ khi cần làm ví dụ để kiểm chứng một phát biểu về sản phẩm, **không** phải đối
tượng ta đang xây. Việc của consumer thuộc SDLC của chính consumer đó.

## Cấu trúc

```text
00.governance      luật của tree này: cái gì là SoT, cái gì được cite
 → 01.inception    vision · mission · goals · objectives — vì sao tồn tại, đi đâu
 → 02.landscape     bối cảnh: sản phẩm đứng ở đâu, ai cho gì, chỗ ta không chơi
 → 02.requirements   sản phẩm phải LÀM được gì (phát biểu kiểm chứng được)
 → 03.analysis      PHÂN TÍCH: actor · use case · user story · AC — *ai, làm gì*
 → 06.data-design   DỮ LIỆU: entity · quan hệ · schema Postgres · RLS
 → 07.interface-design  HỢP ĐỒNG: endpoint C1↔C2 · bề mặt cho A-01/A-08
 → 04.architecture   mô hình: trục sản phẩm, bề mặt, seam, provider, graph
 → 08.wbs            WBS duy nhất — Feature → Epic → Story → Task
 → 10.test           phép thử nói lên "done" nghĩa là gì
```

Đã mở: `06.data-design` (entity · schema) · `07.interface-design` (hợp đồng · bề mặt).

Bỏ trống có chủ ý (thêm khi có nội dung thật, không tạo folder rỗng): `09.change`, `11.delivery`, `12.operations`.

## Quy ước

- Tên file và folder, trừ `README.md`: `{NN}.{kebab-case}`.
- **Mỗi file trả lời đúng một câu hỏi.** File nào trả lời câu hỏi trùng thì sửa file cũ, không tạo file mới.
- Ngày tháng **tuyệt đối** (`2026-10-24`), không "tuần trước", "gần đây". Tree này được đọc lạnh.
- Mọi con số kèm **cách đo** hoặc ngày đo. Số không đo được là ý kiến, phải ghi rõ là ý kiến.
- Không chép nội dung đã có trong `documents/`; **link**.

## SoT (source of truth)

| Thứ | SoT | Ghi chú |
|---|---|---|
| Vision · mission · goals · objectives | [`01.inception/01.vision/01.vision-mission-goals.md`](./01.inception/01.vision/01.vision-mission-goals.md) | hợp nhất vision+mission+goals+objectives trong **một** file để không lệch nhau |
| **Vì sao sản phẩm tồn tại** (5 pain point) | [`01.inception/00.problem.md`](./01.inception/00.problem.md) | nguồn gốc; vision lệch file này thì vision sai |
| Quyết định sản phẩm (đã chốt / còn treo) | [`01.inception/02.decision-log/00.index.md`](./01.inception/02.decision-log/00.index.md) | `D-nn` chốt · `Q-nn` treo, **bắt buộc** có tiêu chí chốt |
| Mô hình bề mặt (Console/Observatory, tầng đọc) | [`04.architecture/02.product-surfaces.md`](./04.architecture/02.product-surfaces.md) | thiết kế mức cao; trang/component là tầng thấp, chưa chốt |
| WBS | [`08.wbs/00.index.md`](./08.wbs/00.index.md) | **chỉ ở đây**. Không tạo WBS thứ hai |
| Sản phẩm là gì / chạy thế nào | `documents/` | reference, không phải direction |
| Đang hỏng gì | [`documents/05.development/03.open-issues.md`](../documents/05.development/03.open-issues.md) | issue là *hiện trạng*, không phải *kế hoạch* |
| Invariant phải giữ | [`documents/05.development/02.invariants.md`](../documents/05.development/02.invariants.md) | luật kỹ thuật; `sdlc/` không được mâu thuẫn |
| Defect đã có ID | [`documents/05.development/09.gate-defect-register.md`](../documents/05.development/09.gate-defect-register.md) | cite `G-nn`, không mô tả lại |

## Luật của tree

1. **Goal phải phản chứng được.** Không viết được "điều gì chứng minh goal này sai" ⇒ chưa phải goal.
2. **Question treo phải có phép thử phân xử**, không phải danh sách phương án.
3. **Objective phải chỉ ra nó phục vụ Goal nào.** Objective không phục vụ goal nào là scope trôi.
4. **Không mở lại `D-nn`** trừ khi phép thử phản chứng của nó thất bại — khi đó viết `D` mới thay thế.
5. **Không đưa việc của consumer vào đây.** Nếu một objective chỉ có nghĩa với một consumer, nó không phải
   objective của sản phẩm.
