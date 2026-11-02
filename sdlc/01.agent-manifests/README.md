---
sot_doc_version: "0.1.0"
source_of_truth: "sdlc/06.analysis/README.md"
status: DRAFT
phase: 2
id: MANIFEST-README
type: capability-index
---

# 00 — Agent manifests

> **Why.** A peer receives an execution pack and must **not crawl** `sdlc/`. A pack cannot hold the repo, so it points at **one**
> spec here. baplatform calls it *"Agent Manifest Domain Spec"*; ESO keeps the concept, changes the content.

## 1. A spec **is** / **is not**

| Is | Is not |
|---|---|
| a **contract**: what may change here · what must hold · what proves it | an architecture document — it **points at** architecture, never replaces it |
| **short**: **≤ 40 dòng** ([`D-43`](../03.inception/02.decision-log/02.san-pham-va-pham-vi.md)) | a copy of `sdlc/07.technical/01.architecture/` |
| **falsifiable**: each rule has its test | a manifesto |

**The rule that matters:** a spec longer than a minute of reading is **wrongly designed** — the peer skips it and crawls again,
which is what SLP exists to prevent.

## 2. Shape

```yaml
human_sot: "sdlc/…"        # the HUMAN document this distils
id: <ID>-SPEC
type: capability-spec
```

Body: **what it owns** · **rules** · **wire** (endpoints/tables) · **refs** (AC/SCN paths).
**Budget:** `wc -l` ≤ 150 · `wc -c` ≤ 4 000 ([standard](../02.governance/01.standard/02.artifacts.md) §1.3).

## 3. Domains (v2) — one exists, on purpose

| Domain | Responsibility | Status |
|---|---|---|
| [`eso-core`](01.domains/eso-core.spec.md) | judgement: sufficiency · level · mode · requirement | ✅ sample |
| `eso-knowledge` · `eso-graph` · `eso-evidence` · `eso-control-plane` · `eso-adapters` | see the manifest table | not created |

**Creation rule:** a domain gets a spec only when a **real story** points at it. A spec before a story documents what does not exist.

## 4. Capability specs

Nine, one per analysis item: [`02.capabilities/`](02.capabilities/00.index.md).

## Ngân sách dòng — đo 2026-11-03

`D-43` đặt **router ≤ 40 dòng/file**. Đo thật:

| File | Dòng | Ghi chú |
|---|---:|---|
| 7 domain spec mới (`eso/knowledge` … `eso/extractors`) | **40** | ✅ vừa khít |
| `02.capabilities/00.index` · `01`…`09` | 24–38 | ✅ |
| `03.sufficiency.spec` · `10.surfaces.spec` | **41** · **45** | ⚠ vượt nhẹ |
| `01.domains/eso-core.spec` | **53** | ⚠ vượt — đã cắt khối `invariants` trùng với §2 |
| `README.md` (file này) | **48** | ⚠ vượt — là **bản đồ**, không phải router |

**Điều đo được:** ngân sách 40 **đạt được** — bảy spec mới vừa đúng 40 với cùng hình dạng frontmatter. Nên bốn file vượt là **nội dung dư**, không
phải ngân sách sai.

**Cách trả, theo thứ tự:** cắt phần đã có ở doc mà spec trỏ tới → cắt khối trùng → chỉ khi hết cả hai mới tách file. **Không** nâng ngân sách để
vừa nội dung: làm thế thì con số chỉ còn là lời chúc.
