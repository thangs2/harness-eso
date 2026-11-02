---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/01.architecture/09.evidence-plane.md"
status: DRAFT
phase: 6
id: ESO-EVIDENCE-DOMAIN
type: domain-spec
domain: eso/evidence
owner_role: build
allowed_files:
  - "eso/evidence/**"
  - "qc/eso-ev-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-ev-*"
design_refs:
  - "sdlc/07.technical/01.architecture/09.evidence-plane.md"
  - "sdlc/07.technical/02.data-design/04.evidence-turn.md"
---
# eso/evidence — evidence
## 1. What this domain owns

**One** thing: record append-only của từng turn, và **risk** như trạng thái hạng nhất.

| Owns | Does not own |
|---|---|
| record append-only của từng turn, và **risk** như trạng thái hạng nhất | ra phán quyết (`eso/core`) · chẩn đoán (`eso/control-plane`) |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-EV-01** | **Chỉ ghi thêm** — không `UPDATE`, không `DELETE`; hiện trạng = replay sự kiện | `BR-06` |
| **INV-EV-02** | **`unknown` ≠ `absent`** — nói lẫn là nói dối một cách tự tin | `BR-05` |
| **INV-EV-03** | Mỗi turn ghi **nội dung đã dùng** (`hash` + `commit` + dirty) | `BR-11` |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
