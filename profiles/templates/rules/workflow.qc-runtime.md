---
description: QC lane — trigger gates then qc-runtime after qualified DEV; not every Done
layer: workflow
ide: antigravity
alwaysApply: false
globs: "sdlc/10.test/**/*,SDLC/10.test/**/*,sdlc/08.wbs/**/*,SDLC/08.wbs/**/*,.cursor/agents/qc-runtime.md,.agents/agents/qc-runtime.md"
version: "1.0.0-mechanism"
canonical: AGENTS.md
---

# QC runtime lane (mechanism)

**When:** Execute QC scenario matrix after **qualified DEV** (verify PASS + audit ≥85 + HIR-ready).  
**Not:** Dev implement (`workflow.agentic-factory`) · product-domain rubric auditors.  
**Pairs:** agent `qc-runtime` · optional consumer QC skill.

## Flow

```text
DEV HIR-qualified → trigger gates → qc In Progress → qc-runtime execute → QC HIR → human Done
```

## Trigger gates (any CRITICAL → BLOCKED)

- DEV not verify+audit qualified  
- Missing scenario matrix / `ac_ref` map  
- Dual-harness fail when harness in scope  

## Execute

Follow `.cursor/agents/qc-runtime.md` ≡ `.agents/agents/qc-runtime.md`.  
Evidence: commands, AC coverage, residual OPEN. Agent stops at QC Human In Review — never Story Done.
