# Provisioning FinESO with Harness‑ESO

*Last updated: 2026‑10‑16*

---

## Overview
This runbook describes the **production-grade provisioning and configuration** needed to integrate the **Harness‑ESO** stack (`@mu/harness-*`) into the **FinESO** repository (`FinESO`).

> [!IMPORTANT]
> **Working Directory Discipline:**  
> - Commands that manage product profiles (`node packages/harness-cli/src/cli.mjs init profile`, `./docker/observatory.sh`) must be run from `harness-eso`.
> - Commands that inspect/edit repo files, test hooks, or run local checks must be run from inside `FinESO` (`cd ~/Workspaces/FinESO`).  
> **Never** execute consumer hooks (`.harness/host-pack/harness-hook.mjs`) when your shell's working directory is `harness-eso`—doing so will cause runtime session files (`.eso-preflight.json`) to leak into the product repository.

---

## 1. Prerequisites
- **Node ≥ 20**, **Bun** installed on host.
- **Docker Desktop / Engine** running (for the Observatory dashboard & AgentMemory).
- Sibling clone topology in the workspace directory (e.g. `~/Workspaces`):
  ```bash
  cd ~/Workspaces
  # verify repositories exist
  ls -d harness-eso FinESO
  ```
- **Port allocation** for multi-tenant Observatory instances:
  - **`8792`**: `x79` (primary consumer)
  - **`8793`**: `baplatform` (BA Platform)
  - **`8794`**: **`FinESO`**
- **AgentMemory instance** for FinESO listening on port **`3311`** (Viewer on **`3313`**).

---

## 2. Initialise Harness‑ESO in `FinESO`

From `harness-eso`, run the initialization command specifying the target root, consumer ID, and port:

```bash
# Navigate to harness-eso root
cd ~/Workspaces/harness-eso

# Apply provisioning (dual-IDE support: Cursor + Antigravity)
node packages/harness-cli/src/cli.mjs init profile ../FinESO --id fineso --port 8794
```

This operation creates/updates:
- `FinESO/.harness/host-pack/` (`harness-hook.mjs`, `route-hook.py`, `path-policy.default.json`)
- `FinESO/.harness/decision-policy.json` (merged with Token-Diet & Cognition gate)
- `FinESO/.harness/host-bootstrap.json` & `sidecar.env`
- `FinESO/.cursor/hooks.json` & `.agents/hooks.json`

---

## 3. Align Port Tenancy (Port 8794)

Ensure `harness.config.json` and sidecar files reflect port `8794`:

```json
{
    "version": 1,
    "project": {
        "id": "fineso",
        "displayName": "FinESO"
    },
    "server": {
        "host": "127.0.0.1",
        "port": 8794
    }
}
```

---

## 4. MCP & Recon Tools Configuration

For architectural details on pre-turn reconnaissance sequencing and cognition gates, see [Recon Trinity & Cognition Flows](./06.recon-and-cognition-flows.md).

### A. Cursor MCP (`.cursor/mcp.json`)
FinESO uses **global CLI for Docgraph** (avoiding stdio daemon crashes and eliminating `@modelcontextprotocol/sdk` dependencies). The MCP configuration only registers servers that require persistent protocol streams:

```json
{
  "mcpServers": {
    "agentmemory-mcp": {
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3311",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3313"
      }
    },
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": [
        "serve",
        "--mcp",
        "--path",
        "/Users/thangs2net/Workspaces/FinESO"
      ],
      "env": {
        "CODEGRAPH_ALLOW_UNSAFE_NODE": "1"
      }
    },
    "deepseek-direct": {
      "command": "/opt/homebrew/bin/bun",
      "args": [
        "run",
        "/Users/thangs2net/.gemini/antigravity/deepseek_direct.js"
      ],
      "env": {
        "DEEPSEEK_ENV_FILE": "/Users/thangs2net/.gemini/antigravity/deepseek.env"
      }
    }
  }
}
```

### B. Antigravity MCP (`.agents/mcp_config.json`)

> [!CAUTION]
> **IDE Isolation Invariant:**  
> `.agents/` and `.cursor/` are two strictly independent configuration trees. **Cross-referencing paths between them (A → B or B → A) is strictly prohibited**.  
> Specifically: `.agents/mcp_config.json` must never execute or reference script files inside `.cursor/mcp/` and vice versa. Each IDE manages its own MCP runtime configuration independently.

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": [
        "-y",
        "@agentmemory/mcp"
      ],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3311",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3313"
      }
    },
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": [
        "serve",
        "--mcp",
        "--path",
        "/Users/thangs2net/Workspaces/FinESO"
      ],
      "env": {
        "CODEGRAPH_ALLOW_UNSAFE_NODE": "1"
      }
    },
    "deepseek-direct": {
      "command": "/opt/homebrew/bin/bun",
      "args": [
        "run",
        "/Users/thangs2net/.gemini/antigravity/deepseek_direct.js"
      ],
      "env": {
        "DEEPSEEK_ENV_FILE": "/Users/thangs2net/.gemini/antigravity/deepseek.env"
      }
    },
    "chrome-devtools": {
      "command": "/Users/thangs2net/.bun/bin/chrome-devtools-mcp",
      "args": [
        "--executablePath",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--headless",
        "--viewport",
        "1920x1080"
      ],
      "env": {
        "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1"
      }
    }
  }
}
```

### C. Docgraph CLI
- Local index resides in `FinESO/.docgraph/`.
- Both IDE environments (Cursor and Antigravity) use the shared **global CLI** `docgraph` without requiring an MCP daemon.
- Re-index command:
  ```bash
  cd ~/Workspaces/FinESO && docgraph build
  ```
- Query command:
  ```bash
  docgraph --q "<financial_terms>"
  ```

---

## 5. Token-Diet Conformance Verification

FinESO strictly complies with **STD-ESO-PERF-01**:

| Metric | Budget | FinESO Actual | Status |
|---|---|---|---|
| **Eager Rules Count** | $\le 7$ | **5 rules** | **PASS** |
| **Eager Prefix Tokens** | $\le 5,000$ | **2,427 tokens** | **PASS** |
| **Frontmatter Integrity** | 0 conflicts | **0 conflicts** | **PASS** |
| **Lazy Globs Integrity** | 0 missing | **0 missing** | **PASS** |

### Rule Breakdown:
* **Eager Rules (`alwaysApply: true`, no `globs`):**
  1. `core.conversation-hygiene.mdc` (Context & Token discipline)
  2. `core.law-gate.mdc` (Mandatory AGENTS.md gate)
  3. `core.pipeline-gate.mdc` (Dispatcher-Brain-Executor separation)
  4. `core.scope-fallback.mdc` (Isolation & Gated paths)
  5. `core.workspace-isolation.mdc` (Workspace isolation)
* **Lazy Rules (`alwaysApply: false`, scoped with `globs:`):**
  1. `fineso.deterministic-math.mdc` (`packages/**/*.{js,mjs,ts}`)
  2. `fineso.evidence-discipline.mdc` (`packages/**/*.{js,mjs,ts},documents/**/*.md,SDLC/**/*.md`)
  3. `fineso.chief-of-staff-dag.mdc` (`packages/fineso-core/**,packages/fineso-decision/**`)
  4. `fineso.data-lake-governance.mdc` (`data-lake/**,packages/fineso-adapters/**`)
  5. `fineso.doc.mermaid.mdc` (`SDLC/**,documents/**,task/**,packages/**`)
  6. `fineso.doc.mermaid.trigger.mdc` (`SDLC/**/*.md,documents/**/*.md,task/**/*.md,packages/**/*.md`)
  7. `fineso.doc.mermaid.verify.mdc` (`SDLC/**/*.md,documents/**/*.md,task/**/*.md,packages/**/*.md`)

---

## 6. Verification & Health Check

To verify the installation on `FinESO`:

1. Run the Token-Diet auditor:
   ```bash
   node -e "import('@mu/harness-foundation/token-diet').then(m => console.log(m.scanTokenDiet('../FinESO')))"
   ```
2. Verify preflight execution:
   ```bash
   cd ~/Workspaces/FinESO
   node .harness/host-pack/harness-hook.mjs preflight
   cat .cursor/session/.eso-preflight.json
   ```
3. Verify write-guard:
   ```bash
   python3 .cursor/hooks/guard-write.py AGENTS.md
   # Expected: blocked unless valid attestation is present
   ```
