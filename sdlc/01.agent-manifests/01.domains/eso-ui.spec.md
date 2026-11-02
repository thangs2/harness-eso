---
sot_doc_version: "0.1.0"
human_sot: "sdlc/08.ui-design/01.surfaces.md"
status: DRAFT
phase: 6
id: ESO-UI-DOMAIN
type: domain-spec
domain: eso/ui
owner_role: build
allowed_files:
  - "eso/ui/**"
  - "qc/eso-ui-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-ui-*"
design_refs:
  - "sdlc/08.ui-design/01.surfaces.md"
  - "sdlc/07.technical/03.api/00.index.md"
---
# eso/ui — control plane UI
## 1. What this domain owns

**One** thing: bề mặt đọc/ghi cho người: config · IAM · chẩn đoán · graph.

| Owns | Does not own |
|---|---|
| bề mặt đọc/ghi cho người: config · IAM · chẩn đoán · graph | luật nghiệp vụ · phán quyết · lưu trữ |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-UI-01** | **Không luật nghiệp vụ trong UI** — UI hiển thị và gửi, không quyết | `D-16` |
| **INV-UI-02** | **Client sinh từ contract**, không gõ tay | `D-72` |
| **INV-UI-03** | **Không import code UI của v1** — hai cây không sửa nhau | `D-74` |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
