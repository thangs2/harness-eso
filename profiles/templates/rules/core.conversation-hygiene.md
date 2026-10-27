---
description: Token efficiency and context hygiene — AgentMemory and Graph first, Range-Read, bounded shell
layer: core
ide: antigravity
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
---

# Context Hygiene & Token Performance

1. **AgentMemory First:** Run `memory_smart_search` at turn start for keywords, prior session context, and ticket facts.
2. **Docgraph First:** Query concepts and requirements via `docgraph --q "<terms>"` (30-50 lines). Only Read full docs when Docgraph has no match.
3. **Codegraph First:** Locate symbols, blast radius, and AST hierarchies via `codegraph_explore` in 1 round-trip. Only Grep/Read when AST is unavailable.
4. **Range-Read Discipline:** Never view whole files > 100 lines. Slice with `StartLine`/`EndLine` or `sed -n 'X,Yp'`.
5. **Shell Output Discipline:** Never dump > 40 lines into context. Pipe: `git status -s`, `head -n 30`, `tail -n 25`.
6. **Micro-Rules Architecture:** Keep eager rules <= 6. Scope task-specific rules with `globs:`.
7. **Distillation & Save:** Call `memory_save` at turn closure to preserve decisions and lessons for subsequent turns.
