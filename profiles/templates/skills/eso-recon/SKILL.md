---
name: eso-recon
description: Reconnaissance Trinity workflow (AgentMemory -> Docgraph -> Codegraph) for Harness ESO before modifying code.
---

# ESO Reconnaissance Trinity Skill

Before modifying code or planning architecture in a Harness ESO governed repository, execute the Recon Trinity in order:

## 1. AgentMemory First (Context Discovery)
- Call `memory_smart_search` on MCP `agentmemory` to retrieve past decisions, ticket context, and known caveats.
- Extract key symbols, ticket IDs, and file paths to narrow subsequent searches.

## 2. Docgraph (Law & Architecture)
- Run `docgraph --q "<terms>"` via CLI to inspect domain invariants, ADRs, and law files without reading whole files.
- Verify contracts and architectural boundaries before designing.

## 3. Codegraph (Symbols & Call Hierarchy)
- Call `codegraph_explore` on MCP `codegraph` (`projectPath` = workspace root) to map AST symbols, callers, and blast radius.
- Use slice reading (`view_file` with precise `StartLine` and `EndLine`) only if whole-file verification is required.

Closing evidence gaps satisfies ESO preflight and unlocks guarded paths.
