# Consumer Maturity Diagnostic

- **Consumer:** `fineso` (`/Users/thangs2net/Workspaces/FinESO`)
- **Standard:** consumer-maturity v1.2.0
- **At:** 2026-10-22T13:26:58.480Z
- **Tier reached:** **T5**
- **Summary:** pass=25 fail=0 criticalFail=0

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
| T2.1 | T2 | WARN | PASS | docgraph.scope at repo root | file docgraph.scope |
| T2.2 | T2 | WARN | PASS | AGENTS.md supreme law present | file AGENTS.md |
| T2.3 | T2 | INFO | PASS | Codegraph index directory (.codegraph) | dir .codegraph |
| T2.4 | T2 | INFO | PASS | Docgraph index directory (.docgraph) | dir .docgraph |
| T3.1 | T3 | WARN | PASS | 00.context-contract.json present | found sdlc/00.governance/00.context-contract.json |
| T3.2 | T3 | WARN | PASS | Agent manifests zone present | found sdlc/00.agent-manifests |
| T3.3 | T3 | INFO | PASS | eso-coverage.json scorecard | file .harness/eso-coverage.json |
| T3.4 | T3 | WARN | PASS | docgraph.scope lists Agent Zone path | docgraph.scope contains path:SDLC/00.agent-manifests |
| T4.1 | T4 | INFO | PASS | Engineering *-runtime agents (Cursor) | 7 match(es) under .cursor/agents (need ≥5) |
| T4.2 | T4 | INFO | PASS | pipeline-gate rule present (Cursor) | found .cursor/rules/core.pipeline-gate.mdc |
| T4.3 | T4 | INFO | PASS | Engineering skill (*engineering*) present (Cursor) | 1 match(es) under .cursor/skills (need ≥1) |
| T4.4 | T4 | INFO | PASS | brain-dispatch skill present (Cursor) | found .cursor/skills/brain-dispatch/SKILL.md |
| T4.5 | T4 | INFO | PASS | Dual-harness verify script (or BAP parity equivalent) | found scripts/ci/verify-dual-harness.mjs |
| T5.1 | T5 | INFO | PASS | jira-impl.sh present (optional lane) | file scripts/jira-impl.sh |
| T5.2 | T5 | INFO | PASS | workflow.agentic-factory rule present (Cursor) | found .cursor/rules/workflow.agentic-factory.mdc |
| T5.3 | T5 | INFO | PASS | workflow.qc-runtime rule or qc-runtime agent present | found .cursor/rules/workflow.qc-runtime.mdc |
| T5.4 | T5 | INFO | PASS | delivery.workflow lean rule present (optional lane) | found .cursor/rules/delivery.workflow.mdc |
---
Verify is **read-only**. Apply remediations manually or via provision/sync — do not invent domain rules from another consumer.
