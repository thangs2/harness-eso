# Harness ESO Operational Manual & Workflow Guide (Consumer Workflow Guide)

> **Document Code:** `HARNESS-ESO-CONSUMER-GUIDE`  
> **Applies to:** All consumer repositories integrated with Harness ESO (`x79`, `baplatform`, `FinESO`, etc.).  
> **Objective:** Comprehensive guide for both Operators (human developers) and AI Agents (Cursor / Google Antigravity) detailing ESO operational mechanics, the end-to-end pipeline data flow, quality control gates, and token optimization discipline.

---

## 1. Core Architecture: The 3-Plane Model

Harness ESO operates under a strict separation of concerns across three distinct planes:

```mermaid
flowchart TD
    subgraph OperatorPlane["1. Operator Plane (Human Developer)"]
        CLI["./harness CLI"]
        Console["Console Wizard (:8791)"]
        Observatory["Observatory Monitor (:8792 / :8793)"]
    end

    subgraph DispatcherPlane["2. Dispatcher Plane (IDE Agent)"]
        IDE["Cursor / Antigravity"]
        Preflight["Preflight Hook (.eso-preflight.json)"]
        Guards["Guards: guard-write.py, guard-shell.py"]
    end

    subgraph BrainPlane["3. Cognition & Brain Plane"]
        DeepSeek["DeepSeek Pro / Flash (MCP)"]
        ReconTools["docgraph-cli · codegraph-cli · agentmemory-mcp"]
    end

    OperatorPlane -->|"Supervision & Governance"| DispatcherPlane
    DispatcherPlane -->|"Complex Reasoning & Gap Closure"| BrainPlane
    BrainPlane -->|"Attestation & Artifacts"| DispatcherPlane
    DispatcherPlane -->|"Tracer & Telemetry"| Observatory
```

1. **Operator Plane (Human Developer):**
   - Controls the system via `./harness` and the Observatory monitor dashboard (`http://127.0.0.1:8792` or project-scoped port).
   - Retains supreme authority, configures `decision-policy.json`, assigns token budgets, and approves human-in-the-loop (HIL) exceptions.
2. **Dispatcher Plane (IDE Agent - Cursor / Antigravity):**
   - Serves as the turn orchestrator and forwarder.
   - Runs locally inside the IDE, interacting with the codebase through specialized tools.
   - Constrained by automated runtime hooks: Preflight, Guard-Write, Guard-Shell, and Route Tracer.
3. **Brain & Recon Plane (Cognition & Context Tools):**
   - **Brain Tier:** DeepSeek MCP (Flash for rapid reasoning, Pro for complex architecture and design).
   - **Recon Tools:** `docgraph` (law/spec lookup via CLI), `codegraph` (symbol/AST lookup via MCP), `agentmemory` (cross-session memory via MCP).

---

## 2. End-to-End Pipeline Data Flow & Decision Orchestration

This section outlines the complete turn lifecycle of data within Harness ESO: from user prompt input, through deterministic classification, adapter reconnaissance, evidence sufficiency evaluation, cognitive routing, precision execution, to knowledge distillation.

```text
[USER SUBMITS PROMPT]
  │
  ▼
[STEP 1: INITIALIZATION & LAW GATE (Law Gate & Context Load)]
  │   - Mandatory Load: AGENTS.md (Workspace Invariants & Sacred Pipeline)
  │   - Intent Classification: Pure Q&A? Jira Lookup? Code Modification?
  │   - Protective Guardrails: Forbid unrequested git commits, preserve comments, enforce minimal diffs
  │
  ▼
[STEP 2: CLASSIFICATION & AMBIGUITY RESOLUTION (Decision Facade: L0 vs Jev)]
  │   - Configuration Scan: Read `decision-policy.json` (load `jev.mode`, `on_ambiguous`)
  │
  ├── 2.1 LEVEL L0 (Deterministic Rules — 0ms Latency, Zero Cost)
  │     │   Regex Scan + Bucket Mapping:
  │     │
  │     ├── [Shell Command Evaluation]:
  │     │     ├── IF prohibited command (rm -rf, git push --force, dropdb)
  │     │     │     └──► L0 HARD BLOCK (`verdict = deny`, winner: `l1_shell_deny`) -> HALT
  │     │     ├── IF safe read command (git status, ls, bun test)
  │     │     │     └──► L0 IMMEDIATE ALLOW (`verdict = allow`, winner: `l1_shell_allow`)
  │     │     └── IF unknown / gray-zone command
  │     │           └──► Assign `verdict = ask` -> Escalate to Level 2.2
  │     │
  │     └── [Route Bucket Mapping (frontend / backend / docs / root)]:
  │           ├── IF unambiguously matches exactly 1 bucket (no contention)
  │           │     └──► L0 WINS (`winner = l0_resolver`, NO JEV CALL)
  │           └── IF tied score / conflicting signals (`l0.tie`)
  │                 └──► Assign `kind = ambiguous` -> Escalate to Level 2.2
  │
  └── 2.2 LEVEL L1/L2 (Jev System One — HTTP Call to api.typesafe.ai)
        │
        ├── IF `policy.jev.mode === 'off'`
        │     └──► Bypass Jev -> Escalate directly to Human Approval (`HIL Required`)
        │
        └── IF `policy.jev.mode === 'active'` (or `'shadow'`)
              │   Send HTTP request to Jev Classifier to break ambiguity tie
              │
              ├── IF Confidence ≥ 0.9 (High Confidence)
              │     └──► JEV WINS (`winner = route_jev`, enforces target bucket)
              │
              └── IF Confidence < 0.9 (Low Confidence)
                    └──► HALT AND PROMPT USER (`winner = jev_confirm`, `HIL Required`)
  │
  ▼
[STEP 3: RECONNAISSANCE VIA ADAPTERS (Evidence Collection)]
  │   - Activate matching Skill Pack according to Step 2 bucket
  │   - Gather factual ground truth across 3 independent Adapters (avoid dumping full files):
  │
  ├── 3.1 `agentmemory-mcp` (Long-Term Episodic Memory):
  │     └── Call `memory_smart_search` -> Retrieve: Ticket facts, past architectural decisions, touched paths
  │
  ├── 3.2 `docgraph-cli` (Authoritative Law & Invariants):
  │     └── Run `docgraph --q "<terms>"` -> Extract: 30–50 line slices of Invariants, DoR, API Contracts
  │
  └── 3.3 `codegraph-cli` (Code Graph & Symbol AST):
        └── Call `codegraph_explore` -> Extract: AST trees, Call Hierarchies, Blast Radius in 1 round-trip
  │
  ▼
[STEP 4: EVIDENCE SUFFICIENCY GATE (Scoring & Gate Enforcement)]
  │
  ├── 4.1 DETECT CONTEXT GAPS (Detect Gaps):
  │     │   Cross-examine Step 3 evidence against Skill Pack requirements:
  │     ├── Missing required architectural law?   ──► Generate gap: `MISSING_LAW_EVIDENCE`
  │     ├── Insufficient minimum path reads?      ──► Generate gap: `MISSING_READ_EVIDENCE`
  │     └── Aggregate into consolidated gap list: `gaps = [...]`
  │
  ├── 4.2 QUANTITATIVE SCORING ENGINE:
  │     └── Compute score: `score = (lawRatio * 0.55) + (readRatio * 0.45)`
  │
  ├── 4.3 SUFFICIENCY LEVEL CLASSIFICATION:
  │     ├── IF score ≥ T_high AND gaps.length === 0 ──► SUFFICIENT (Full 100% Evidence Adequacy)
  │     ├── IF score ≥ T_low                       ──► PARTIAL (Partially Grounded)
  │     └── OTHERWISE (score < T_low or open gaps) ──► INSUFFICIENT (Lacks Necessary Context)
  │
  └── 4.4 GATE ENFORCEMENT & BRANCHING:
        │
        ├── Case 1: SUFFICIENT
        │     └──► GREEN FLAG: Grant code write authorization (`allowWrite = true`) -> Proceed to Step 5
        │
        ├── Case 2: INSUFFICIENT AND `enforceWrites = fail_closed`
        │     └──► RED FLAG (HARD BLOCK): Reject write with `ESO_INSUFFICIENT_EVIDENCE`
        │          (Agent prohibited from editing files; must return to Step 3 to close gaps)
        │
        ├── Case 3: INSUFFICIENT AND `insufficientPromptGate = consent`
        │     └──► YELLOW FLAG (AWAITING APPROVAL): Enter `ConsentPending` state
        │          (Prompt user: "Context insufficient. Approve proceeding anyway?")
        │
        └── Case 4: INSUFFICIENT AND `eso.mode = observe / hint`
              └──► ALLOW WITH ADVISORY: Inject context gap advisory block into prompt
  │
  ▼
[STEP 5: BRAIN TIER ROUTING (Cognition Allocation)]
  │   - Dispatcher evaluates task complexity based on task specs and gathered context:
  │
  ├── 5.1 ZERO BRAIN (Dispatcher / IDE Tools Only):
  │     ├── Conditions: Jira/doc lookup, test execution, file listing, single-line typo/config fix
  │     └──► Dispatcher operates directly via IDE tools (0 external model tokens consumed)
  │
  ├── 5.2 BRAIN FLASH (`ask_deepseek_flash`) (DEFAULT WORKHORSE):
  │     ├── Conditions: Clear task specifications, Test-Driven Development (TDD), bugfix with concrete stack trace
  │     └──► Invoke Flash for rapid, syntactically clean, cost-efficient code generation
  │
  └── 5.3 BRAIN PRO (`ask_deepseek_pro`) (DEEP REASONING):
        ├── Conditions: New Domain Model design, invariant violations, deadlock/memory leak,
        │              or Brain Flash failed 2 consecutive test runs
        └──► Invoke Pro with Chain-of-Thought (multi-step reasoning) for holistic architectural synthesis
  │
  ▼
[STEP 6: SAFE EXECUTION & RANGE-READ (Precision Patching & Output Discipline)]
  │
  ├── 6.1 SLICE READING DISCIPLINE:
  │     └── Never dump files > 100 lines into conversation context.
  │         Only use `view_file` specifying exact `StartLine` and `EndLine` slices.
  │
  ├── 6.2 SURGICAL CODE MODIFICATION:
  │     └── Use `replace_file_content` to apply exact targeted patches, strictly preserving existing comments.
  │
  ├── 6.3 LOCAL VERIFICATION & BOUNDED TERMINAL OUTPUT:
  │     │   Run test runner (`bun test`, `vitest`) with output piped (`| tail -n 25`)
  │     │
  │     ├── IF Tests Fail:
  │     │     └──► Extract exact error stack trace -> Return to **Step 5** for Brain remediation
  │     │
  │     └── IF Tests Pass:
  │           └──► Summarize results concisely (e.g., "All 241 tests passed") -> Proceed to Step 7
  │
  ▼
[STEP 7: KNOWLEDGE DISTILLATION & MEMORY SAVE]
  │   - Call `memory_save` via `agentmemory-mcp`
  │   - Record concise distillation:
  │       + Modified files, classes, and exported symbols
  │       + Finalized architectural decisions
  │       + Discovered lessons and defects (to prevent recurrence)
  │   - Outcome: Future turns or sessions inherit this context immediately at Step 3.1
  │
  ▼
[STEP 8: USER HANDOFF & RESPONSE]
      - Render clickable markdown file links (`file:///...`)
      - Succinctly report verified test execution outcomes
      - Outline next steps or hand off control to user
```

---

## 3. ESO Runtime Safeguards: Preflight, Gap Closure & Guard Rails

### A. Preflight Phase (Before Prompt Execution)
Whenever the user submits a prompt, the `preflight` hook evaluates the turn intent:
- Determines whether the request targets protected files (`gated paths`).
- Measures context sufficiency and records state into `.cursor/session/.eso-preflight.json` (or `.agents/session/`).
- Computes verdict: `level: full` (execution allowed) or `level: partial` / `insufficient` (context gaps identified).

### B. Gap Closure Protocol
When Preflight flags `level: partial` or `insufficient`:
1. **Differentiate Task Nature:**
   - **Code / Bugfix / Implementation Tasks:** Dispatcher must run Recon (`codegraph`, `docgraph`, `memory`) to load factual ground truth before calling Brain for code generation, preventing hallucination.
   - **Docs / WBS / Analysis / RFC Tasks:** Brain is **encouraged to engage in Deep Thinking immediately** to structure solutions, analyze requirements, or direct targeted inquiry. Preflight does not block Brain reasoning.
2. **Protected Write Enforcement (`guard-write.py`):** For both Code and Docs, writing to sensitive files is unlocked only when backed by verified evidence and a fresh Brain attestation (No Evidence → No Claim).
3. **Recon Lookup Order:**
   - `memory_smart_search`: Retrieve previous session context, ticket facts, and decisions.
   - `docgraph --q "<terms>"`: Extract relevant specifications, guidelines, or business rules.
   - `codegraph_explore`: Extract AST symbols, caller/callee graphs, and interface definitions.

### C. Guard Rails
- **`guard-write.py`:** Blocks unauthorized modifications to protected files: `AGENTS.md`, `.cursor/rules/`, `.agents/rules/`, SDLC baselines, and CI scripts. Edits require fresh Brain attestation or explicit user direction.
- **`guard-shell.py`:** Monitors dangerous terminal commands and enforces local test validation (`bun test` or project runner) before turn completion.

---

## 4. Context Discipline & Token-Diet Standard (STD-ESO-PERF-01)

To eliminate **Token Burn** (runaway context inflation caused by dumping full files into conversation histories), all Agents must adhere to the **8-Step Discipline**:

```text
[1. AgentMemory First]  --> Search keywords, ticket facts, previous decisions
          │
[2. Docgraph First]     --> Retrieve precise spec sections (30-50 lines). Never read whole files!
          │
[3. Codegraph First]    --> Explore AST/symbols in 1 round-trip. Avoid unbounded greps
          │
[4. Range-Read]         --> Read specific slices (StartLine..EndLine) if opening a file is necessary
          │
[5. Bounded Shell]      --> Limit terminal output <= 40 lines (always pipe head/tail)
          │
[6. Micro-Rules]        --> Maintain eager rules budget <= 6; scope specialized rules with globs
          │
[7. Local Test]         --> Verify small diffs locally with automated test runners
          │
[8. Memory Save]        --> Call memory_save to distill key takeaways for subsequent turns
```

### Token-Diet Ceilings:
- **Eager Rules Budget:** Maximum **6–7 rules** declared with `alwaysApply: true`.
- **Eager Prefix Token Budget:** Initial session tokens $\le$ **5,000 tokens** (including eager rules + `AGENTS.md` + root instruction files).
- **Single Responsibility Rule:** All specialized rules (backend, frontend, database, Jira, WBS) must declare `alwaysApply: false` paired with explicit `globs:`.

---

## 5. CLI Tooling & Runtime Monitoring

### A. Token Budget Validation with the Linter CLI
Run the Token-Diet auditor from the project root:
```bash
# Global audit across all IDE configurations
./harness token-diet <path-to-consumer>

# Audit Cursor configuration exclusively
./harness token-diet <path-to-consumer> --tree cursor

# Audit Google Antigravity configuration exclusively
./harness token-diet <path-to-consumer> --tree agents

# Export audit findings as JSON
./harness token-diet <path-to-consumer> --json
```

### B. Runtime Monitoring via Observatory (`http://127.0.0.1:8792`)
- Access `:8792` (or project port e.g. `:8793`) in a browser to monitor Agent turn execution in real time.
- Check the **`eager-prefix-budget`** indicator under **Conformance Checks**:
  - `PASS`: Eager rules count and tokens remain within safety limits.
  - `WARN`: Eager prefix exceeded budget, risking context pollution.
- Inspect the **Drill Blocks → Flow Graph** to trace which rules fired and which tools were invoked sequentially.

### C. Host Pack Hook Management
```bash
# Verify installed hook status
./harness host-pack status <path-to-consumer>

# Refresh/update hooks when harness-eso updates
./harness host-pack refresh <path-to-consumer>
```

---

## 6. Troubleshooting Guide

| Symptom | Root Cause | Standard Resolution |
|---|---|---|
| **Write command rejected by `guard-write`** | Target file is `gated` (e.g. `AGENTS.md`, `.cursor/rules/`) and lacks valid attestation. | Query `docgraph` or `codegraph` to close identified gaps; obtain Brain attestation before retrying. Do not attempt to bypass guards. |
| **Observatory displays `eager-prefix-budget` = WARN** | Too many rule files configured with `alwaysApply: true`. | Execute `./harness token-diet` to identify offending rules. Assign proper `globs:` and switch to `alwaysApply: false`. |
| **Input tokens spike dramatically across turns** | Unbounded `Read` loaded entire large files into conversation history. | Enforce Slice Reading (`StartLine` / `EndLine`). Persist facts to `AgentMemory` rather than re-reading files in subsequent turns. |
