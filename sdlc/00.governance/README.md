---
sot_doc_version: "0.1.0"
source_of_truth: "sdlc/README.md"
status: DRAFT
phase: 1
id: GOV-README
type: standard
---

# 00 — Governance

The law of this tree. Short, and limited to what would be violated if unwritten.

**Two independent number sequences.** Folders are numbered `01…` and files are numbered `01…` **separately** — a folder number
says nothing about a file number. Mixing them (`01.file` · `02.file` · `03.folder`) is forbidden
([naming law](./01.standard/02.artifacts.md) §4).

### Folders

| # | Folder | Role |
|---|---|---|
| 01 | [`01.standard/`](./01.standard/00.index.md) | **the normative rules**: `01` gates & marks · `02` shape of 16 document kinds · `03` BIP/FIP packets |
| 02 | [`02.quality-gate/`](./02.quality-gate/00.index.md) | **the instruments**: `01` lifecycle standard · `02` pre-flight · `03` go/no-go · `04` artifact flow |

### Files

| # | File | Role |
|---|---|---|
| 01 | [`01.sources.md`](./01.sources.md) | what may be cited · the **phase gate** (`D-40`) |
| 02 | [`02.sdlc-workflow.md`](./02.sdlc-workflow.md) | the **study** of baplatform's SDLC: 8 stages · 4 planes · three document kinds · C4 ladder |
| 03 | [`03.document-status.md`](./03.document-status.md) | **DOCUMENT STATUS STANDARD — precondition P0.3**: what "documented" means · **X1–X8** · measured instance |
| 04 | [`04.open-register.md`](./04.open-register.md) | the **`OPEN` register**: unanswered shape questions, each with a proposal |

`README.md` is the only unnumbered file here — it is **navigation**, not an artifact.

**Two layers, two rules.** `01.standard` holds what must be **true**; `02.quality-gate` holds where you **check** it; `03` is the
register the gates read. No rule is copied into a form, and no form invents a rule.

`documents/` is the law of the **current state** (invariants, defect register, feature map). `sdlc/` may write, but must not contradict
`documents/`. On conflict: `documents/` describes what the code does, so `sdlc/` must change — or open a `D` to change the current
state.
