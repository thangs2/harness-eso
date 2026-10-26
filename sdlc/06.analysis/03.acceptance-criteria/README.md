# 03 — Acceptance criteria

**Trạng thái:** `DRAFT` · 2026-10-25 · **Nguồn:** [`../02.user-stories/`](../02.user-stories)

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
| `US-SUF-01` | `AC-SUF-01-01`…`05` | [`01.suf-us-01-agent.md`](01.suf-us-01-agent.md) | ✅ |
| `US-SUF-02` | `AC-SUF-02-01`…`04` | [`02.suf-us-02-operator.md`](02.suf-us-02-operator.md) | ✅ |
| `US-AGENT-01` | `AC-AGENT-01-01`…`03` | [`03.agent-us-01-scope.md`](03.agent-us-01-scope.md) | ✅ |
| `US-KB-01` | `AC-KB-01-01`…`03` | [`04.kb-us-01-isolation.md`](04.kb-us-01-isolation.md) | ✅ |
| `US-IAM-01` | `AC-IAM-01-01`…`03` | [`05.iam-us-01-workers.md`](05.iam-us-01-workers.md) | ✅ |
| `US-IAM-02` | `AC-IAM-02-01`…`04` | [`06.iam-us-02-roles.md`](06.iam-us-02-roles.md) | ✅ |
| `US-IAM-03` | `AC-IAM-03-01`…`04` | [`07.iam-us-03-policies.md`](07.iam-us-03-policies.md) | ✅ |
| `US-IAM-04` | `AC-IAM-04-01`…`03` | [`08.iam-us-04-flows.md`](08.iam-us-04-flows.md) | ✅ |
| `US-IAM-05` | `AC-IAM-05-01`…`04` | [`09.iam-us-05-accept.md`](09.iam-us-05-accept.md) | ✅ |
| `US-IAM-06` | `AC-IAM-06-01`…`04` | [`10.iam-us-06-config.md`](10.iam-us-06-config.md) | ✅ |
| `US-CFG-01` | `AC-CFG-01-01`…`04` | [`11.cfg-us-01-config-page.md`](11.cfg-us-01-config-page.md) | ✅ |
| `US-SDLC-01` | `AC-SDLC-01-01`…`05` | [`12.sdlc-us-01-setup.md`](12.sdlc-us-01-setup.md) | ✅ |
| `US-SUF-03` | `AC-SUF-03-01`…`3` | [`13.suf-us-03-proactive.md`](13.suf-us-03-proactive.md) | ✅ |
| `US-SUF-04` | `AC-SUF-04-01`…`3` | [`14.suf-us-04-why.md`](14.suf-us-04-why.md) | ✅ |
| `US-EV-01` | `AC-EV-01-01`…`4` | [`15.ev-us-01-record.md`](15.ev-us-01-record.md) | ✅ |
| `US-EV-02` | `AC-EV-02-01`…`3` | [`16.ev-us-02-revert-mark.md`](16.ev-us-02-revert-mark.md) | ✅ |
| `US-KB-02` | `AC-KB-02-01`…`4` | [`17.kb-us-02-select.md`](17.kb-us-02-select.md) | ✅ |
| `US-KB-03` | `AC-KB-03-01`…`4` | [`18.kb-us-03-shared-upgrade.md`](18.kb-us-03-shared-upgrade.md) | ✅ |
| `US-LEARN-01` | `AC-LEARN-01-01`…`3` | [`19.learn-us-01-propose.md`](19.learn-us-01-propose.md) | ✅ |
| `US-HOST-01` | `AC-HOST-01-01`…`4` | [`20.host-us-01-election.md`](20.host-us-01-election.md) | ✅ |
| `US-ARCH-01` | `AC-ARCH-01-01`…`4` | [`21.arch-us-01-graph.md`](21.arch-us-01-graph.md) | ✅ |
| `US-TICKET-01` | `AC-TICKET-01-01`…`4` | [`22.ticket-us-01-integration.md`](22.ticket-us-01-integration.md) | ✅ |

**Tổng: 158 AC** (đếm bằng id, không bằng ước lượng).

**37 AC.** Mỗi file có ba phần bắt buộc ngoài bảng: **điều kiện sau** (ghi gì), **test sẽ chứng minh** (tên test cụ thể), và
**AC này KHÔNG kiểm** (ranh giới — để không phình).

Danh sách id **đã giữ chỗ** trong US tương ứng ([`../02.user-stories/`](../02.user-stories)). Mỗi file AC chứa **tất cả AC của một US** — vì AC chỉ có nghĩa trong ngữ cảnh US của nó.

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
