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

| # | Folder / file | Role |
|---|---|---|
| 01 | [`01.source-of-truth/`](./01.source-of-truth/) | what may be cited, what is the source of truth · **the phase gate** |
| 02 | [`02.sdlc-workflow.md`](./02.sdlc-workflow.md) | **the SDLC workflow**: 8 stages · 4 planes · three document kinds · C4 ladder · BIP/FIP · phase order |
| 03 | [`03.sdlc-standard/`](./03.sdlc-standard/00.index.md) | **SDLC STANDARD (normative)**: marks `OK/P/OUT/—` · statuses `READY/READY-SPLIT/BLOCKED` · **shape of 16 document kinds** · BIP/FIP |
| 04 | [`04.open-register.md`](./04.open-register.md) | **`OPEN` register**: the shape questions that blocked stages 4–5, each with a proposal; answered ones are cited, not re-asked |
| 05 | [`05.document-status.md`](./05.document-status.md) | **DOCUMENT STATUS STANDARD**: what "documented" means · **8 cross-checks (X1–X8)** · how a status is claimed · measured instance |
| 06 | [`06.quality-gate/`](./06.quality-gate/00.index.md) | **gates (1:1 with BAP `03.quality-gate/`)**: `01` lifecycle · `02` pre-flight · `03` go/no-go · `05` gate-flow |

`documents/` is the law of the **current state** (invariants, defect register, feature map). `sdlc/` may write, but must not contradict
`documents/`. On conflict: `documents/` describes what the code does, so `sdlc/` must change — or open a `D` to change the current
state.
