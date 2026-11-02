---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/01.architecture/11.host-capability.md"
status: DRAFT
phase: 6
id: ESO-ADAPTERS-DOMAIN
type: domain-spec
domain: eso/adapters
owner_role: build
allowed_files:
  - "eso/adapters/**"
  - "qc/eso-adapter-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-adapter-*"
design_refs:
  - "sdlc/07.technical/01.architecture/11.host-capability.md"
  - "sdlc/07.technical/01.architecture/05.turn-execution.md"
---
# eso/adapters — host adapters
## 1. What this domain owns

**One** thing: cầu nối vào host: DSH · Cursor · Antigravity — và **khai** năng lực host.

| Owns | Does not own |
|---|---|
| cầu nối vào host: DSH · Cursor · Antigravity — và **khai** năng lực host | phán quyết (`eso/core`) · đọc source (`eso/extractors`) |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-AD-01** | **Thiếu năng lực thì nói ra và hạ `guarantee`** — không im lặng, không đoán thay | `REQ-HOST-02` |
| **INV-AD-02** | **Mỗi turn ghi nhánh nguồn năng lực đã chọn** | `REQ-HOST-03` |
| **INV-AD-03** | **Sản phẩm không gọi model** — quyết định là của người | `D-13` · mission |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
