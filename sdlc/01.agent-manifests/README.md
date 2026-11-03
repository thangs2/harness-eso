---
sot_doc_version: "0.1.0"
source_of_truth: "sdlc/06.analysis/README.md"
status: DRAFT
phase: 2
id: MANIFEST-README
type: capability-index
---

# 00 — Agent manifests

> **Why.** Peer nhận pack và **không được crawl** `sdlc/`. Pack không chứa được repo, nên nó trỏ tới **một** spec ở đây.

## 1. A spec **is** / **is not**

| Is | Is not |
|---|---|
| a **contract**: what may change here · what must hold · what proves it | an architecture document — it **points at** architecture, never replaces it |
| **short**: spec **≤ 150 dòng / 4 000 ký tự** ([`standard` §1.3](../02.governance/01.standard/02.artifacts.md)) · router **≤ 40 dòng** ([`D-43`](../03.inception/02.decision-log/02.san-pham-va-pham-vi.md)) | a copy of `sdlc/07.technical/01.architecture/` |
| **falsifiable**: each rule has its test | a manifesto |

> Luật: spec đọc quá lâu là spec **thiết kế sai** — peer bỏ qua và crawl lại, đúng thứ SLP sinh ra để chặn.

## 2. Shape

`human_sot` (doc HUMAN nó chưng cất) · `id` · `type` · **body**: owns · rules · wire · refs.

Body: **what it owns** · **rules** · **wire** (endpoints/tables) · **refs** (AC/SCN paths).
**Budget:** spec `wc -l` ≤ 150 · `wc -c` ≤ 4 000 ([standard](../02.governance/01.standard/02.artifacts.md) §1.3); **router** (file chỉ để trỏ) ≤ 40 dòng.

## 3. Hai bộ spec

| Bộ | Là gì | Số |
|---|---|---:|
| [`01.domains/`](01.domains/00.index.md) | **ranh giới ghi** của một miền — `allowed_files` · bất biến · điều cấm | **8** |
| [`02.capabilities/`](02.capabilities/00.index.md) | **hợp đồng** một năng lực — nó sở hữu gì · nối ở đâu · kiểm bằng gì | **9** |
  03.capability-wbs.md   ✅ capability ↔ work package (nối bằng chuỗi US → AC → WP, không bằng tay)

## 4. Capability specs

Nine, one per analysis item: [`02.capabilities/`](02.capabilities/00.index.md).
