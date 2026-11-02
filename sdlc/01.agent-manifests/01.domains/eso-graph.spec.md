---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/01.architecture/06.architecture-model.md"
status: DRAFT
phase: 6
id: ESO-GRAPH-DOMAIN
type: domain-spec
domain: eso/graph
owner_role: build
allowed_files:
  - "eso/graph/**"
  - "qc/eso-graph-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-graph-*"
design_refs:
  - "sdlc/07.technical/01.architecture/06.architecture-model.md"
  - "sdlc/07.technical/01.architecture/18.graph-queries.md"
---
# eso/graph — architecture model
## 1. What this domain owns

**One** thing: mô hình kiến trúc: `node` · `edge` · `provenance` · `completeness` theo từng câu hỏi.

| Owns | Does not own |
|---|---|
| mô hình kiến trúc: `node` · `edge` · `provenance` · `completeness` theo từng câu hỏi | đọc source (`eso/extractors`) · phán quyết (`eso/core`) |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-GR-01** | **Không bịa cạnh** — `derived ⊆ source`, mỗi edge nêu nguồn sinh ra nó | `BR-16` |
| **INV-GR-02** | **`completeness` theo từng câu hỏi**, không một số chung | `06` §8 |
| **INV-GR-03** | Dưới `floor` ⇒ **cấm** claim `absent` | `06` §8.1 |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
