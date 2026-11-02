---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/01.architecture/15.code-graph-baplatform.md"
status: DRAFT
phase: 6
id: ESO-EXTRACTORS-DOMAIN
type: domain-spec
domain: eso/extractors
owner_role: build
allowed_files:
  - "eso/extractors/**"
  - "qc/eso-ext-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-ext-*"
design_refs:
  - "sdlc/07.technical/01.architecture/15.code-graph-baplatform.md"
  - "sdlc/07.technical/01.architecture/01.c4/02.container.md"
---
# eso/extractors — graph extractors
## 1. What this domain owns

**One** thing: đọc source của consumer ⇒ **danh sách node/edge có type**.

| Owns | Does not own |
|---|---|
| đọc source của consumer ⇒ **danh sách node/edge có type** | áp dụng mô hình (`eso/graph`) · phán quyết |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-EX-01** | **Ra cùng một dạng** (edge list có type) bất kể ngôn ngữ | `D-36` |
| **INV-EX-02** | **Không tự ghi vào `graph`** — trả kết quả, `eso/graph` quyết định | ranh giới miền |
| **INV-EX-03** | **Chạy ngoài đường turn** — build graph không được chặn turn | `05` §4 |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
