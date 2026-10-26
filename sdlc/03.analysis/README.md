# 03 — Analysis

**Trạng thái:** `DRAFT` · 2026-10-25 · **Giai đoạn:** discovery → planning ([`D-40`](../01.inception/02.decision-log/00.index.md))

> **Vì sao folder này tồn tại.** `04.architecture/` có 17 file mô tả **cách hệ thống chạy**, nhưng chưa có một dòng nào
> mô tả **ai dùng nó để làm gì**. Kiến trúc đang trả lời câu hỏi **chưa được phát biểu**.
>
> Folder này phát biểu câu hỏi đó — theo thứ tự: **ai → làm gì → để làm được thì phải thoả gì**.

## Bắt đầu từ đây

[`00.pain-point-trace.md`](./00.pain-point-trace.md) — **P1–P6 → REQ → UC → US → AC**, và **tài liệu đầu tiên** mỗi nỗi đau
cần. Đọc cái này trước để biết chỗ nào trống.

## 1. Cấu trúc

```text
01.business-analysis/
  01.actors.md          ✅ ai — và ai có QUYỀN gì
  02.use-cases.md       ✅ làm gì — UC-* với điều kiện trước/sau
  03.business-rules.md  ✅ luật xuyên use case (BR-01…BR-13)
  05.iam-functions.md   ✅ kế hoạch 6 chức năng IAM — đã đủ: 6 US + 23 AC
  06.eso-features.md    ✅ **danh mục 18 chức năng của harness-eso** + trạng thái (6 ✅ · 1 🟡 · 11 ❌)
02.user-stories/        ✅ **22 US**: SUF-01…04 · AGENT-01 · KB-01…03 · EV-01/02 · IAM-01…06 · CFG-01 · SDLC-01 · LEARN-01 · HOST-01 · ARCH-01 · TICKET-01
03.acceptance-criteria/ ✅ **85 AC**
04.quality-control/     ✅ 7 matrix · **78 dòng SCN** · 03.iam-rtm · 0 executed
```

⬜ = **chưa tạo**, vì chưa có nội dung thật. Repo này không tạo folder rỗng.

## 2. Luật của folder này

| Luật | Vì sao |
|---|---|
| **UC không nhắc tới công nghệ** | nếu UC nói "Postgres" thì nó là thiết kế, không phải phân tích |
| **Mỗi UC có điều kiện trước/sau** | không có "sau" thì không biết đã xong chưa |
| **AC phải test được bằng một test** | luật của [Stages](../00.governance/02.sdlc-workflow.md) §1 |
| **AC thuộc ĐÚNG một US** | AC dùng US khác thì không test được một mình; luật xuyên suốt là **BR**, không phải AC |
| **US truy về P1–P6** | không truy được thì nó là ý thích, không phải yêu cầu |
| **Không chép lại `04.architecture`** | analysis nói *cái gì*, architecture nói *thế nào* |

## 3. Thứ tự đọc

```text
01.inception/00.problem.md      (P1–P6 — nỗi đau)
  → 03.analysis/01.*            (ai, làm gì)
    → 03.analysis/02–03         (US, AC)
      → 04.architecture/        (thế nào)
```

Đọc ngược lại là đọc **giải pháp trước vấn đề** — đúng thứ tự tôi đã làm sai trong phiên này.
