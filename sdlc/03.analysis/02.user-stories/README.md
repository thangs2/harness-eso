# 02 — User stories

**Trạng thái:** `DRAFT` · 2026-10-25 · **Nguồn:** [`../01.business-analysis/02.use-cases.md`](../01.business-analysis/02.use-cases.md)

> **Mỗi US = một mẩu giá trị, một actor, và một câu trả lời được bằng một test.**
> Nếu một US cần hai actor ⇒ **tách**. Nếu cần chữ "tùy" ⇒ **tách**.

## 1. Định dạng bắt buộc

```yaml
---
us: US-<MIỀN>-<nn>
actor: A-nn
uc: UC-nn
p: Pn
status: draft | ready-for-ac
---
```

Thân bài:

| Mục | Trả lời câu gì |
|---|---|
| **Story** | As … I want … so that … |
| **Giá trị thật thuộc về ai** | với actor là **máy**, giá trị phải truy về **người** — nếu không, ta đang xây cho agent |
| **Vì sao không gộp với US khác** | nếu không trả lời được, hai US nên là một |
| **Trong / ngoài phạm vi** | ranh giới rõ, không "vân vân" |
| **AC dự kiến** | danh sách id — AC viết ở [`../03.acceptance-criteria/`](../03.acceptance-criteria/) |

## 2. Danh sách

| ID | Story | Actor | UC | P | AC |
|---|---|---|---|---|---|
| [`US-SUF-01`](./01.us-suf-01-agent.md) | agent biết **phải bổ sung gì** trước khi giao việc | A-02 | UC-01 | P4 | ✅ 5 AC |
| [`US-SUF-02`](./02.us-suf-02-operator.md) | người biết **agent có đủ không** trước khi yêu cầu | A-01 | UC-01 | P4 | ✅ 4 AC |
| [`US-AGENT-01`](./03.us-agent-01-scope.md) | **vượt phạm vi** bị từ chối và ghi lại | A-01 | UC-04 | P6 | ✅ 3 AC |
| [`US-KB-01`](./04.us-kb-01-isolation.md) | project mới **không thấy** tri thức project khác | A-01 | UC-05 | P3 | ✅ 3 AC |
| [`US-IAM-01`](./05.us-iam-01-workers.md) | thêm/bớt worker, **việc dở đi đâu** | A-01 | UC-04 | P6 | ✅ 3 AC |
| [`US-IAM-02`](./06.us-iam-02-roles.md) | role mang **`scope`** + **`bar`** | A-01 | UC-04 | P6 | ✅ 4 AC |
| [`US-IAM-03`](./07.us-iam-03-policies.md) | policy theo **thuộc tính**, chỉ người sửa | A-01 | UC-04 | P6 | ✅ 4 AC |
| [`US-IAM-04`](./08.us-iam-04-flows.md) | bàn giao **bị chặn** nếu thiếu bằng chứng | A-02 | UC-04 | P6 | ✅ 3 AC |
| [`US-IAM-05`](./09.us-iam-05-accept.md) | **accept** nợ có người + hạn | A-01 | UC-11 | P6 | ✅ 4 AC |
| [`US-IAM-06`](./10.us-iam-06-config.md) | đổi config: **preview** · một lần · **revert** | A-01 | UC-05 | P3 | ✅ 4 AC |
| [`US-CFG-01`](./11.us-cfg-01-config-page.md) | **một page config**: SDLC · đội · tool · project | A-01 | UC-05 | P3 | ✅ 4 AC |
| [`US-SDLC-01`](./12.us-sdlc-01-setup.md) | **thiết lập SDLC** vào project: init · check · upgrade | A-01 | UC-05 | P3 | ✅ 5 AC |

⬜ = AC **chưa viết**; đây là bước kế tiếp của Stage 2, không được coi là Ready.

## 3. Luật

| Luật | Vì sao |
|---|---|
| một US **một** actor | AC kiểu "tùy người hỏi" **không test được bằng một test** |
| **AC thuộc đúng một US** | AC mà phải dùng US khác thì không độc lập; thuộc tính xuyên suốt là **BR** |
| một US phải truy về **UC** và **P** | không truy được thì là ý thích |
| "so that" phải nêu **hậu quả nếu không có** | "so that it works better" không phải giá trị |
| không nhắc công nghệ | như UC |
