# `06.analysis` — Phân tích

**Trạng thái:** `DRAFT` · 2026-10-25 · **Giai đoạn:** discovery → planning ([`D-40`](../03.inception/02.decision-log/00.index.md))

> **Vì sao folder này tồn tại.** `07.technical/01.architecture/` có 17 file mô tả **cách hệ thống chạy**, nhưng chưa có một dòng nào
> mô tả **ai dùng nó để làm gì**. Kiến trúc đang trả lời câu hỏi **chưa được phát biểu**.
>
> Folder này phát biểu câu hỏi đó — theo thứ tự: **ai → làm gì → để làm được thì phải thoả gì**.

## Bắt đầu từ đây

[`00.pain-point-trace.md`](00.pain-point-trace.md) — **P1–P7 → REQ → UC → US → AC**, và **tài liệu đầu tiên** mỗi nỗi đau
cần. Đọc cái này trước để biết chỗ nào trống.

## 1. Cấu trúc

```text
01.business-analysis/
  01.actors.md            ✅ 8 actor — ai, và ai có QUYỀN gì
  02.use-cases.md         ✅ 14 UC-* với trigger · trước · sau
  03.business-rules.md    ✅ 18 luật xuyên use case (BR-01…BR-18)
  05.iam-functions.md     ✅ 6 chức năng IAM — 6 US + 23 AC
  06.eso-features.md      ✅ 23 chức năng (18 v1 + 5 v2) + trạng thái
  07.us-feature-map.md    ✅ US → feature: một nguồn, epic của story suy từ đây
  00.baseline-v2-narrative/ ✅ **14 narrative v2** — 305–543 dòng/bản, 11 mục cố định
02.user-stories/          ✅ **54 US**
03.acceptance-criteria/   ✅ **349 AC** · 12 miền · US nào cũng có ≥ 1 AC
04.quality-control/       ✅ **356 SCN** · 14 matrix · 0 đã chạy
```
⬜ = **chưa tạo**, vì chưa có nội dung thật. Repo này không tạo folder rỗng.

> **Sửa 2026-11-02.** Khối trên từng ghi `22 US` · `333 AC` · `337 dòng SCN` · `343/433 AC phủ` · `18 chức năng` · `BR-01…BR-13`, và
> **không hề nhắc** `00.baseline-v2-narrative/`. Đo lại: **54 · 349 · 355 · 0 chạy · 23 · 18**. Mọi con số cũ đều **thấp hơn** thật —
> nghĩa là tài liệu này đã ngừng được cập nhật từ lâu và vẫn đang là cửa vào của folder.

## 2. Luật của folder này

| Luật | Vì sao |
|---|---|
| **UC không nhắc tới công nghệ** | nếu UC nói "Postgres" thì nó là thiết kế, không phải phân tích |
| **Mỗi UC có điều kiện trước/sau** | không có "sau" thì không biết đã xong chưa |
| **AC phải test được bằng một test** | luật của [Stages](../02.governance/01.standard/04.sdlc-workflow.md) §1 |
| **AC thuộc ĐÚNG một US** | AC dùng US khác thì không test được một mình; luật xuyên suốt là **BR**, không phải AC |
| **US truy về P1–P7** | không truy được thì nó là ý thích, không phải yêu cầu |
| **Không chép lại `07.technical/01.architecture`** | analysis nói *cái gì*, architecture nói *thế nào* |

## 3. Thứ tự đọc

```text
03.inception/00.problem/00.index.md      (P1–P7 — nỗi đau)
  → 06.analysis/01.*            (ai, làm gì)
    → 06.analysis/02–03         (US, AC)
      → 07.technical/01.architecture/        (thế nào)
```

Đọc ngược lại là đọc **giải pháp trước vấn đề** — đúng thứ tự tôi đã làm sai trong phiên này.
