---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/02.data-design/03.declaration-format.md"
status: DRAFT
phase: 6
id: ESO-KNOWLEDGE-DOMAIN
type: domain-spec
domain: eso/knowledge
owner_role: build
allowed_files:
  - "eso/knowledge/**"
  - "qc/eso-kb-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-kb-*"
design_refs:
  - "sdlc/07.technical/02.data-design/03.declaration-format.md"
  - "sdlc/07.technical/01.architecture/12.configuration-and-store.md"
---
# eso/knowledge — knowledge
## 1. What this domain owns

**One** thing: nội dung skill/rule và **ba vùng** `pool` · `shared` · `project`.

| Owns | Does not own |
|---|---|
| nội dung skill/rule và **ba vùng** `pool` · `shared` · `project` | áp tri thức (`eso/core`) · ghi record (`eso/evidence`) |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-KB-01** | **Mỗi `kind` đúng một người chịu** — không chủ thì không duyệt được | `BR-14` · `X27` |
| **INV-KB-02** | **Tri thức bền chỉ vào KB qua quyết định của người**: máy **không** tự duyệt | `BR-15` |
| **INV-KB-03** | Nâng `shared` ⇒ **mọi** project theo, trừ project đã `đè`, và việc đè **phải hiện ra** | `REQ-KB-03` |
| **INV-KB-04** | **Conformance công bố mọi phép kiểm**: `pass` · `fail` · `OUT` + lý do — không phép kiểm nào **vắng mặt** hay bị **bỏ qua im lặng** | `BR-20` · `ESO-458` |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
