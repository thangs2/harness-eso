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

## 2. AC phải nêu **điều kiện sau**, không chỉ kết quả

Một AC chỉ nói *"trả về …"* là chưa đủ, vì nó không nói **cái gì đã được ghi lại**. Ở hệ này, phần lớn giá trị nằm ở
postcondition: phán quyết có được ghi, `basis` có được giữ, `unknowns[]` có được nêu.

## 3. Danh sách AC theo US

| US | AC dự kiến | Trạng thái |
|---|---|---|
| `US-SUF-01` | `AC-SUF-01-01`…`05` | ⬜ chưa viết |
| `US-SUF-02` | `AC-SUF-02-01`…`05` | ⬜ chưa viết |

Danh sách id **đã giữ chỗ** trong US tương ứng ([`../02.user-stories/`](../02.user-stories/)). Viết AC là bước kế tiếp, và
mỗi AC sẽ nằm trong file riêng: `{NN}.{ac-id}.md`.

## 4. Truy vết bắt buộc

```text
P1..P6  ←  UC-nn  ←  US-…  ←  AC-…  ←  test
```

Thiếu mắt nào cũng là lỗi: AC không truy được về P là AC **bịa**; AC không có test là AC **trang trí**.

## 5. Ba câu phải trả lời được cho mỗi AC

1. Test nào chứng minh nó? (nếu không chỉ ra được test ⇒ AC chưa xong)
2. Nếu nó **sai** thì ai phát hiện, và khi nào? (nếu không ai phát hiện ⇒ AC không có giá trị)
3. Nó có thể **sai một cách tự tin** không? (ví dụ: trả `absent` khi thật ra là `unknown` — đây là lỗi tệ nhất hệ này
   có thể mắc)
