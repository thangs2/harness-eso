---
sot_doc_version: "0.1.0"
human_sot: "sdlc/01.agent-manifests/README.md"
status: DRAFT
phase: 6
id: ESO-CORE-DOMAIN
type: domain-spec
domain: eso-core
owner_role: build
allowed_files:
  - "packages/eso-core/**"
  - "qc/eso-*.test.mjs"
forbidden:
  - "sdlc/**"                      # a peer must NOT edit this spec; Lead or human only
  - "packages/harness-*"           # v1 code — prior art, untouched by v2 stories
  - "documents/**"
verify:
  - "bun test qc/eso-core-*"
design_refs:
  - "sdlc/07.technical/01.architecture/07.sufficiency.md"
  - "sdlc/07.technical/01.architecture/05.turn-execution.md"
invariants:
  - INV-ESO-01
  - INV-ESO-02
  - INV-ESO-03
---

# eso-core — judgement

## 1. What this domain owns

**One** thing: turning *(actor, task, evidence)* into **one explainable verdict**.

| Owns | Does not own |
|---|---|
| deriving **requirements** ([07](../../07.technical/01.architecture/07.sufficiency.md) §1) | knowledge content (`eso-knowledge`) |
| computing `level` · `basis` · `exists` in aggregate | graph completeness measurement (`eso-graph`) |
| choosing `mode` from `level × permission × escalation` | writing records (`eso-evidence`) |
| **explanation**: why this verdict, with sources | the interface (`eso-control-plane`) |

## 2. Invariants

| ID | Invariant | Checked by |
|---|---|---|
| **INV-ESO-01** | **Never conclude `sufficient` without `basis`.** A `sufficient` with no basis is a claim with no source | test: output missing `basis` ⇒ must throw, never default to `retrieved` |
| **INV-ESO-02** | **`cannot-judge` never becomes `permitted` on its own.** No model ⇒ only `ask`/`block`; proceeding requires `bypassed` | test: `cannot-judge` + escalation `allow` still yields `ask` |
| **INV-ESO-03** | **Every requirement must name its source** (`bar` · `work` · `blast` · `declared`). A requirement with no source is invented | test: every `requirements[]` element has a valid `source` |

## 3. Specific prohibitions

1. **Do not redefine "sufficient" elsewhere.** One place computes `level`; everything else reads it.
2. **Do not read another domain's files to infer data** — use the interface. A `eso-core` peer does not grep `eso-graph`.
3. **Do not change thresholds in code** — thresholds are data ([D-11](../../03.inception/02.decision-log/00.index.md)).
4. **Do not "guess to finish"** when data is missing: return `cannot-judge` + `unknowns[]`, never a zero.

## 4. Self-check before reporting DONE

```bash
bun test qc/eso-core-*          # must be green
```

Then answer three questions in the peer output:

1. Did I **default** any value that should have been `unknown`?
2. Does any conclusion lack a **source** in the record?
3. If a threshold changed, would the result move in a direction I do not control?
