---
name: brain-dispatch
description: >-
  Dual Brain Router (Pro + Flash) + Hybrid Executor for Eng-Lead.
  Use when choosing Brain tier, writing Brain stamp, chunking, or running
  build/verify/fixbug/qc engineering loops. Not for product-domain workers.
---

# Brain dispatch (mechanism)

**Plane:** Engineering control plane only. Product/domain finance or SaaS workers → stop → consumer domain skill.  
**Entry law:** consumer `AGENTS.md` · `core.pipeline-gate` · engineering SLP rule/skill.  
**Factory loop:** rule `workflow.agentic-factory`.  
**MCP:** `deepseek-direct` and/or `universal-llm-gateway` (`ask_deepseek_pro`, `ask_deepseek_flash`).

## When to use

- Pick Pro vs Flash for architecture / hard debug / protected-path design.
- Write `.cursor/session/.pipeline-brain-stamp.json` (or `.agents/session/…`) before gated writes.
- Chunk, `-32001`, `PARTIAL`, or Pro hard-fail → Pro-down once.
- Run Eng loops: build → verify → audit → fixbug → qc (via `*-runtime.md`).

## System 1 vs System 2

| Layer | Job | Tools |
|---|---|---|
| System 1 | Route, classify plane, tie-break | `memory_smart_search`, `docgraph --q`, `codegraph_explore` |
| System 2 | Architecture / implement plan | Brain-Pro or Brain-Flash |
| Executor | Apply merge to disk | Flash **no prefix** (thinking OFF) or IDE Write after Brain returned |

Do **not** call `ask_deepseek*` only to choose a rule.

## Dispatcher (Eng-Lead = IDE chat)

1. Read user request verbatim; classify plane (ENG vs product/domain).
2. Read session `.eso-preflight.json` when ESO preflight enabled; close gaps **before** Brain; paste under `[EVIDENCE CONTEXT]`.
3. `memory_smart_search` → `docgraph` → `codegraph_explore` (packages in scope).
4. Forward **raw** context to tier below. No invented summary replacing files.
5. Smart Merge: Brain output + on-disk files + slice notes.
6. Hybrid Executor → `verify-runtime` (Task verify / project test cmd).
7. `memory_save`.

### Forbidden

- Writing code/architecture before Brain returns (when Brain is required for gated path).
- Rewriting Brain output in your own words as the “implementation”.
- Silent local rewrite when MCP Brain is down — write `BRAIN_UNAVAILABLE` stamp, tell user.
- Spawning product-domain workers from this skill.

## Tiers

| Tier | Call | Stamp `via` |
|---|---|---|
| Brain-Pro | `ask_deepseek_pro` (thinking ON) | `ask_deepseek_pro` |
| Brain-Flash | `ask_deepseek_flash`, first line `[BRAIN FLASH]` | `ask_deepseek_flash_brain` |
| Pro-down | same body, first line `[BRAIN FALLBACK]`, once | `ask_deepseek_flash_brain_fallback` |
| Executor | `ask_deepseek_flash`, **no** prefix | stamp already written |

Default: **Flash** for scoped package edits. **Pro** for cross-package architecture, INV/policy conflicts, or user asks deep design.

## Chunk

- ~1–3 files or ~24k–50k chars per call; split above ~60k; never >~200k one shot.
- Do not bisect a class/function mid-body.
- HTTP 429: wait 5s → 15s → 30s, same chunk. No parallel Pro calls.
- Empty Pro content → Pro-down once, not another Pro.
- `-32001`: restart MCP, **same** tier + chunk — not a tier switch.

### Chunk template

```
[USER REQUEST]
<unchanged>

[CHUNK META]
chunk: <i> / <n>
scope: <files>
prior_summary: <prior Brain outputs only>

[MEMORY CONTEXT]
<memory_smart_search hits>

[RAW FILE CONTENTS]
File: path
<raw>

[INSTRUCTION]
Process ONLY this chunk. Honor consumer AGENTS.md invariants and dual-harness.
```

## Hybrid Executor

```
[6a] ask_deepseek_flash (no prefix) ── ok ──► verify
        │ fail
        ▼
[6b] Write / StrReplace / Shell from Brain output already in hand ──► verify
```

## Eng-Lead runtime loop

```text
1. BIND — WBS/Task pack or grill. Enriched Jira → jira-impl (Zero-SDLC-Crawl) when T5.
2. SCOUT/PLAN — scout/plan runtimes when needed; disjoint allowed_files.
3. IMPLEMENT — Brain tier → stamp → executor; build-runtime per slice.
4. VERIFY — verify-runtime (project tests / dual-harness / Task verify).
5. FAIL → fixbug-runtime → back to 4 (max 3 same root → escalate human Supervisor-Eng).
6. PASS → audit-runtime ≥85 & 0 CRITICAL → READY_FOR_HUMAN_REVIEW (HIR).
7. QC — qc-runtime only after qualified DEV; see workflow.qc-runtime.
8. HUMAN — Supervisor-Eng / PO marks Done. Agent does not.
```

## Completion language

| Allowed | Forbidden |
|---|---|
| `READY_FOR_HUMAN_REVIEW`, HIR, command + exit status | Agent “Jira Done”, “shipped”, fake green |
| AC ↔ tests mapped | Skip Task verify command |
