---
sot_doc_version: "0.1.0"
human_sot: "sdlc/07.technical/01.architecture/13.control-plane.md"
status: DRAFT
phase: 6
id: ESO-CONTROL_PLANE-DOMAIN
type: domain-spec
domain: eso/control-plane
owner_role: build
allowed_files:
  - "eso/control-plane/**"
  - "qc/eso-cp-*.test.mjs"
forbidden:
  - "sdlc/**"
  - "packages/harness-*"
  - "docs/**"
verify:
  - "bun test qc/eso-cp-*"
design_refs:
  - "sdlc/07.technical/01.architecture/13.control-plane.md"
  - "sdlc/07.technical/03.api/00.index.md"
---
# eso/control-plane — control plane
## 1. What this domain owns

**One** thing: API · sync · provision · **page config** — hai thẩm quyền tách nhau.

| Owns | Does not own |
|---|---|
| API · sync · provision · **page config** — hai thẩm quyền tách nhau | phán quyết (`eso/core`) · ghi record (`eso/evidence`) |
## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-CP-01** | **Cô lập project** — project này không thấy project kia | `BR-12` |
| **INV-CP-02** | **Một deployment**: một image · một tiến trình · ba database | `D-21` · `D-73` |
| **INV-CP-03** | **Không endpoint nào trên đường turn** | `D-46` |
## 3. Specific prohibitions

- Ghi ngoài `allowed_files`, kể cả "chỉ một file" · sửa `sdlc/**` hoặc `packages/harness-*` (v1 **đóng băng**, `D-74`).
