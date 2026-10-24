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
 → 02.requirements  sản phẩm phải LÀM được gì (phát biểu kiểm chứng được)
 → 04.architecture  mô hình: trục sản phẩm, seam, provider, graph
 → 08.wbs           WBS duy nhất — Feature → Epic → Story → Task
 → 10.test          phép thử nói lên "done" nghĩa là gì
```

Bỏ trống có chủ ý (thêm khi có nội dung thật, không tạo folder rỗng): `03.analysis`, `06.data-design`,
`07.interface-design`, `09.change`, `11.delivery`, `12.operations`.

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
| Quyết định sản phẩm (đã chốt / còn treo) | [`01.inception/02.decision-log/00.index.md`](./01.inception/02.decision-log/00.index.md) | `D-nn` chốt · `Q-nn` treo, **bắt buộc** có tiêu chí chốt |
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
