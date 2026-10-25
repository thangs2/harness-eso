# 03 — Acceptance criteria

**Trạng thái:** `DRAFT` · 2026-10-25 · **Nguồn:** [`../02.user-stories/`](../02.user-stories/)

> **Luật của Stage 2:** *mỗi AC phải test được bằng **một** test*. AC không test được bằng một test là AC chưa viết xong.

## 1. Định dạng — bảng 8 cột (chuẩn học từ baplatform)

| ac_id | type | actor | preconditions | trigger | expected | postconditions | errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AC-…-01` | `happy` | | | | | | — |
| `AC-…-02` | `failure` | | | | | | |
| `AC-…-03` | `edge` | | | | | | |

`type` ∈ `happy` · `failure` · `edge` — **bắt buộc**, vì nó là thứ khiến test có thể **bị đòi**:

| type | Nghĩa | Nếu thiếu |
|---|---|---|
| `happy` | đường chính chạy đúng | không biết nó có chạy được không |
| `failure` | đầu vào xấu ⇒ phải từ chối **đúng cách** | hệ im lặng hoặc làm liều |
| `edge` | biên: rỗng, một phần tử, quá lớn | hỏng ở chỗ không ai thử |

**Luật:** AC có hành vi âm (`failure`/`edge`) **phải** có ít nhất một test thuộc loại đó — không được chỉ test `happy`.

## 2. AC thuộc **đúng một US**

AC mà cần dùng một US khác để kiểm thì **không độc lập** và không test được một mình. Thuộc tính đúng **xuyên** use case là
**luật nghiệp vụ** ([`../01.business-analysis/03.business-rules.md`](../01.business-analysis/03.business-rules.md)), không phải AC.

## 3. AC phải nêu **điều kiện sau**, không chỉ kết quả

Một AC chỉ nói *"trả về …"* là chưa đủ, vì nó không nói **cái gì đã được ghi lại**. Ở hệ này, phần lớn giá trị nằm ở
postcondition: phán quyết có được ghi, `basis` có được giữ, `unknowns[]` có được nêu.

## 4. Danh sách AC theo US

| US | AC | File | Trạng thái |
|---|---|---|---|
| `US-SUF-01` | `AC-SUF-01-01`…`05` | [`01.suf-us-01-agent.md`](./01.suf-us-01-agent.md) | ✅ |
| `US-SUF-02` | `AC-SUF-02-01`…`04` | [`02.suf-us-02-operator.md`](./02.suf-us-02-operator.md) | ✅ |
| `US-AGENT-01` | `AC-AGENT-01-01`…`03` | [`03.agent-us-01-scope.md`](./03.agent-us-01-scope.md) | ✅ |
| `US-KB-01` | `AC-KB-01-01`…`03` | [`04.kb-us-01-isolation.md`](./04.kb-us-01-isolation.md) | ✅ |

**15 AC.** Mỗi file có ba phần bắt buộc ngoài bảng: **điều kiện sau** (ghi gì), **test sẽ chứng minh** (tên test cụ thể), và
**AC này KHÔNG kiểm** (ranh giới — để không phình).

Danh sách id **đã giữ chỗ** trong US tương ứng ([`../02.user-stories/`](../02.user-stories/)). Mỗi file AC chứa **tất cả AC của một US** — vì AC chỉ có nghĩa trong ngữ cảnh US của nó.

## 5. Truy vết bắt buộc

```text
P1..P6  ←  UC-nn  ←  US-…  ←  AC-…  ←  test
```

Thiếu mắt nào cũng là lỗi: AC không truy được về P là AC **bịa**; AC không có test là AC **trang trí**.

## 6. Ba câu phải trả lời được cho mỗi AC

1. Test nào chứng minh nó? (nếu không chỉ ra được test ⇒ AC chưa xong)
2. Nếu nó **sai** thì ai phát hiện, và khi nào? (nếu không ai phát hiện ⇒ AC không có giá trị)
3. Nó có thể **sai một cách tự tin** không? (ví dụ: trả `absent` khi thật ra là `unknown` — đây là lỗi tệ nhất hệ này
   có thể mắc)
