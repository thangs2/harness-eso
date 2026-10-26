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

| # | Folder / file | Role | Kind |
|---|---|---|---|
| 01 | [`01.sources.md`](./01.sources.md) | what may be cited · the **phase gate** (`D-40`) | rule |
| 02 | [`02.sdlc-workflow.md`](./02.sdlc-workflow.md) | the **study** of baplatform's SDLC: 8 stages · 4 planes · three document kinds · C4 ladder | study |
| 03 | [`03.standard/`](./03.standard/00.index.md) | **the normative rules**: `01` gates & marks · `02` shape of 16 document kinds · `03` BIP/FIP packets | **standard** |
| 04 | [`04.quality-gate/`](./04.quality-gate/00.index.md) | **the instruments**: `01` lifecycle standard (9 stages · transitions · roles) · `02` pre-flight · `03` go/no-go · `04` artifact flow | **forms** |
| 05 | [`05.document-status.md`](./05.document-status.md) | **DOCUMENT STATUS STANDARD — precondition P0.3**: what "documented" means · **8 cross-checks X1–X8** · measured instance | **standard** |
| 06 | [`06.open-register.md`](./06.open-register.md) | the **`OPEN` register**: unanswered shape questions, each with a proposal | register |

**Two levels, two rules.** `03` holds what must be **true**; `04` holds where you **check** it. `05` is the **register** the gates read.
No rule is copied into a form, and no form invents a rule.

`documents/` is the law of the **current state** (invariants, defect register, feature map). `sdlc/` may write, but must not contradict
`documents/`. On conflict: `documents/` describes what the code does, so `sdlc/` must change — or open a `D` to change the current
state.
