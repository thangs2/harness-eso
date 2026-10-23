# Consumer Maturity Diagnostic

- **Consumer:** `atrievefin` (`/Users/thangs2net/Workspaces/atrievefin`)
- **Standard:** consumer-maturity v1.3.0
- **At:** 2026-10-23T03:44:07.638Z
- **Tier reached:** **T2**
- **Summary:** pass=18 fail=8 criticalFail=0

| ID | Tier | Sev | Status | Title | Evidence |
| :--- | :---: | :---: | :---: | :--- | :--- |
| T0.1 | T0 | CRITICAL | PASS | Host pack directory present | dir .harness/host-pack |
| T0.2 | T0 | CRITICAL | PASS | harness.config.json with server.port | harness.config.json keys ok |
| T0.3 | T0 | CRITICAL | PASS | Dual-IDE trees exist (.cursor + .agents) | all present (2) |
| T0.4 | T0 | CRITICAL | PASS | Write guards present (both trees) | all present (2) |
| T0.5 | T0 | CRITICAL | PASS | decision-policy.json has paths + eso + tokenDiet | .harness/decision-policy.json keys ok |
| T0.6 | T0 | WARN | PASS | host-install-state.json present | file .harness/host-install-state.json |
| T1.1 | T1 | WARN | PASS | WORKFLOW_GUIDE.md under .harness | file .harness/WORKFLOW_GUIDE.md |
| T1.2 | T1 | WARN | PASS | Session dirs for both IDE trees | all present (2) |
| T1.3 | T1 | WARN | PASS | tokenDiet enabled in decision-policy.json | .harness/decision-policy.json tokenDiet.enabled = true |
| T2.1 | T2 | WARN | PASS | docgraph.scope at repo root | file docgraph.scope |
| T2.2 | T2 | WARN | PASS | AGENTS.md supreme law present | file AGENTS.md |
| T2.3 | T2 | INFO | PASS | Codegraph index directory (.codegraph) | dir .codegraph |
| T2.4 | T2 | INFO | PASS | Docgraph index directory (.docgraph) | dir .docgraph |
| T3.1 | T3 | WARN | FAIL | 00.context-contract.json present | none of: sdlc/00.governance/00.context-contract.json \| SDLC/00.governance/00.context-contract.json |
| T3.2 | T3 | WARN | FAIL | Agent manifests zone present | none of: sdlc/00.agent-manifests \| SDLC/00.agent-manifests |
| T3.3 | T3 | INFO | FAIL | eso-coverage.json scorecard | missing file .harness/eso-coverage.json |
| T3.4 | T3 | WARN | FAIL | docgraph.scope lists Agent Zone path, and that path exists | docgraph.scope declares paths that do not exist: SDLC/00.agent-manifests |
| T4.1 | T4 | INFO | FAIL | Engineering *-runtime agents (Cursor) | no dir .cursor/agents |
| T4.2 | T4 | INFO | PASS | pipeline-gate rule present (Cursor) | found .cursor/rules/core.pipeline-gate.mdc |
| T4.3 | T4 | INFO | FAIL | Engineering skill (*engineering*) present (Cursor) | 0 match(es) under .cursor/skills (need ≥1) |
| T4.4 | T4 | INFO | PASS | brain-dispatch skill present (Cursor) | found .cursor/skills/brain-dispatch/SKILL.md |
| T4.5 | T4 | INFO | FAIL | Dual-harness verify script (or BAP parity equivalent) | none of: scripts/ci/verify-dual-harness.mjs \| scripts/verify-dual-harness.mjs \| scripts/ci/agent-platform-verify.sh \| scripts/ci/metadata-kind-parity.sh |
| T5.1 | T5 | INFO | FAIL | jira-impl.sh present (optional lane) | missing file scripts/jira-impl.sh |
| T5.2 | T5 | INFO | PASS | workflow.agentic-factory rule present (Cursor) | found .cursor/rules/workflow.agentic-factory.mdc |
| T5.3 | T5 | INFO | PASS | workflow.qc-runtime rule or qc-runtime agent present | found .cursor/rules/workflow.qc-runtime.mdc |
| T5.4 | T5 | INFO | PASS | delivery.workflow lean rule present (optional lane) | found .cursor/rules/delivery.workflow.mdc |

## Remediations

### T3.1 — 00.context-contract.json present
- **action:** `docs`
- **hint:** Create consumer-specific context-contract mapping domains → INV-* (do not copy baplatform domains)

### T3.2 — Agent manifests zone present
- **action:** `docs`
- **hint:** Add 00.agent-manifests/01.domains/*.spec.md for THIS consumer's INV

### T3.3 — eso-coverage.json scorecard
- **action:** `docs`
- **hint:** Generate baseline .harness/eso-coverage.json after T3 docs land

### T3.4 — docgraph.scope lists Agent Zone path, and that path exists
- **action:** `sync`
- **hint:** Add explicit Agent Zone line to docgraph.scope (path:sdlc/00.agent-manifests or path:SDLC/00.agent-manifests) before Human Zone path:sdlc|SDLC; the directory it names must exist, not just the line. Then docgraph build.

### T4.1 — Engineering *-runtime agents (Cursor)
- **action:** `docs`
- **hint:** Port 7 engineering workers (scout/plan/build/verify/audit/fixbug/qc) dual-harness

### T4.3 — Engineering skill (*engineering*) present (Cursor)
- **action:** `docs`
- **hint:** Add consumer *-engineering-team skill (dual-harness); do not copy ABP domain skills

### T4.5 — Dual-harness verify script (or BAP parity equivalent)
- **action:** `sync`
- **hint:** Copy profiles/templates/scripts/ci/verify-dual-harness.mjs → scripts/ci/ (or keep consumer parity script)

### T5.1 — jira-impl.sh present (optional lane)
- **action:** `docs`
- **hint:** Only if consumer uses Jira Execution Pack — do not invent a fake Jira lane

---
Verify is **read-only**. Apply remediations manually or via provision/sync — do not invent domain rules from another consumer.
