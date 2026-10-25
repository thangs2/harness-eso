---
domain: eso-core
owner_role: build
allowed_files:
  - "packages/eso-core/**"
  - "qc/eso-*.test.mjs"
forbidden:
  - "sdlc/**"                      # spec này KHÔNG được sửa bởi peer; chỉ Lead/người
  - "packages/harness-*"           # code v1 — prior art, không sửa trong story v2
  - "documents/**"
verify:
  - "bun test qc/eso-core-*"
  - "bun run doc:links"            # sẽ có; nếu chưa có thì bỏ dòng này chứ không giả vờ
design_refs:
  - "../../04.architecture/07.sufficiency.md"
  - "../../04.architecture/05.turn-execution.md"
  - "../../04.architecture/03.v2-high-level-design.md#2-sản-phẩm-bán-một-thứ-phán-quyết-không-phải-cổng"
invariants:
  - INV-ESO-01
  - INV-ESO-02
  - INV-ESO-03
---

# eso-core — phán quyết

## 1. Miền này sở hữu gì

**Một** thứ: biến *(actor, task, bằng chứng)* thành **một phán quyết có thể giải thích**.

| Sở hữu | Không sở hữu |
|---|---|
| dẫn xuất **requirement** ([07](../../04.architecture/07.sufficiency.md) §1) | nội dung tri thức (miền `eso-knowledge`) |
| tính `level` · `basis` · `exists` ở dạng tổng hợp | cách đo completeness của graph (`eso-graph`) |
| chọn `mode` từ `level × permission × escalation` | ghi record (`eso-evidence`) |
| **giải thích**: vì sao ra kết luận đó, dẫn nguồn | giao diện (`eso-control-plane`) |

## 2. Bất biến

| Mã | Bất biến | Kiểm bằng |
|---|---|---|
| **INV-ESO-01** | **Không kết luận `sufficient` khi thiếu `basis`.** `sufficient` thiếu `basis` là khẳng định không nguồn | test: đầu ra thiếu `basis` ⇒ phải ném lỗi, không mặc định `retrieved` |
| **INV-ESO-02** | **`cannot-judge` không bao giờ tự thành `permitted`.** Không mô hình ⇒ chỉ `ask`/`block`; muốn làm phải `bypassed` | test: `cannot-judge` + escalation `allow` vẫn ra `ask` |
| **INV-ESO-03** | **Requirement phải truy được nguồn** (`bar` · `work` · `blast` · `declared`). Requirement không rõ nguồn là requirement bịa | test: mọi phần tử `requirements[]` có `source` hợp lệ |

## 3. Cấm cụ thể

1. **Không tự định nghĩa lại "đủ" ở tầng khác.** Một chỗ duy nhất tính `level`; nơi khác chỉ đọc.
2. **Không đọc file của miền khác để suy ra dữ liệu** — dùng interface. Peer `eso-core` không grep `eso-graph`.
3. **Không đổi ngưỡng trong code** — ngưỡng là dữ liệu ([D-11](../../01.inception/02.decision-log/00.index.md)).
4. **Không "đoán cho xong"** khi thiếu dữ liệu: trả `cannot-judge` + `unknowns[]`, không trả số 0.

## 4. Cách tự kiểm trước khi báo DONE

```bash
bun test qc/eso-core-*          # phải xanh
```

Rồi tự trả lời ba câu, ghi vào output của peer:

1. Có chỗ nào tôi **mặc định** một giá trị mà đáng lẽ phải `unknown` không?
2. Có kết luận nào **không dẫn được nguồn** trong record không?
3. Nếu ngưỡng bị đổi, kết quả có đổi **theo hướng tôi không kiểm soát** không?
