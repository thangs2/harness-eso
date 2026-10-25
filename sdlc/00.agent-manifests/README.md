# 00 — Agent manifests

**Trạng thái:** `DRAFT` · 2026-10-25 · **Greenfield:** tạo mới, chưa từng có

> **Vì sao có folder này.** Trong SLP, peer nhận một **Execution Pack** đủ để làm việc và **không được crawl**
> `sdlc/`. Nhưng pack không thể chứa cả repo — nên nó trỏ tới **một spec miền** (domain spec) nằm ở đây.
>
> Baplatform gọi khái niệm này là *"Agent Manifest Domain Spec"* (`sdlc/00.agent-manifests/01.domains/*.spec.md`). Ta giữ
> **cùng khái niệm**, đổi nội dung: baplatform có miền **nghiệp vụ** (backend, web, aggregate); harness-eso có miền **sản
> phẩm** (judgement, knowledge, evidence, graph, control plane).

## 1. Spec miền là gì — và **không** là gì

| Là | Không là |
|---|---|
| **hợp đồng** giữa Lead và peer: *"phần này thì được sửa gì, phải giữ gì, chạy gì để biết đúng"* | tài liệu kiến trúc — nó **trỏ** tới kiến trúc, không thay |
| **nhỏ**: đọc trong ≤ 1 phút | không phải chỗ chép lại `sdlc/04.architecture/` |
| **có thể sai được**: mỗi luật kèm phép thử | không phải tuyên ngôn |

**Luật quan trọng nhất:** spec miền mà **dài hơn 1 phút đọc** là spec miền **sai thiết kế** — vì peer sẽ bỏ qua nó và
quay lại crawl, đúng thứ SLP muốn tránh.

## 2. Cấu trúc một spec

```yaml
---
domain: <id>                 # khớp `applies_when` của skill/rule (D-19)
owner_role: <role>           # ai chịu trách nhiệm chính
allowed_files: [...]         # glob — peer NGOÀI phạm vi này = BLOCKED_SCOPE
forbidden: [...]             # điều cấm cụ thể của miền
verify: [...]                # lệnh chạy để biết còn đúng
design_refs: [...]           # trỏ tới sdlc/ — KHÔNG chép nội dung
invariants: [...]            # bất biến kèm mã (INV-…)
---
```

## 3. Danh sách miền của harness-eso (v2)

Chưa có file nào ngoài `eso-core` — tạo dần, **chỉ khi** miền đó có việc thật. Không tạo trước cho đẹp.

| Miền | Trách nhiệm | Trạng thái |
|---|---|---|
| [`eso-core`](./01.domains/eso-core.spec.md) | phán quyết: sufficiency · level · mode · requirement | ✅ mẫu |
| [`02.capabilities/`](./02.capabilities/00.index.md) | **spec theo chức năng** (`< 300 tokens`, `human_sot` trỏ về HUMAN) | ✅ IAM |
| `eso-knowledge` | ba thế giới · pool/shared/project · promotion | chưa tạo |
| `eso-graph` | mô hình kiến trúc · nguồn · completeness | chưa tạo |
| `eso-evidence` | record · risk · provenance · revert | chưa tạo |
| `eso-control-plane` | API · DB · sync · UI | chưa tạo |
| `eso-adapters` | hook/plugin cho từng host | chưa tạo |

**Quy tắc tạo:** một miền chỉ được tạo spec khi có **story thật** trỏ vào nó. Spec trước story là tài liệu hoá thứ chưa
tồn tại — đúng thứ repo này cấm.
