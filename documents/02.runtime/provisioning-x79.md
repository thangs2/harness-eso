# Provisioning x79 with Harness‑ESO

*Last updated: 2026‑10‑16*

---

## Overview
This runbook describes the **production-grade provisioning and configuration** needed to integrate and maintain the **Harness‑ESO** stack (`@mu/harness-*`) in the **x79** repository (`x79`), the primary golden consumer for Harness ESO.

> [!IMPORTANT]
> **Working Directory Discipline:**  
> - Commands that manage product profiles (`node packages/harness-cli/src/cli.mjs init profile`, `./docker/observatory.sh`) must be run from `harness-eso`.
> - Commands that inspect/edit repo files, test hooks, or run local checks must be run from inside `x79` (`cd ~/Workspaces/x79`).  
> **Never** execute consumer hooks (`.harness/host-pack/harness-hook.mjs`) when your shell's working directory is `harness-eso`—doing so will cause runtime session files (`.eso-preflight.json`) to leak into the product repository.

---

## 1. Prerequisites
- **Node ≥ 20**, **Bun** installed on host.
- **Docker Desktop / Engine** running (for the Observatory dashboard & AgentMemory).
- Sibling clone topology in the workspace directory (e.g. `~/Workspaces`):
  ```bash
  cd ~/Workspaces
  # verify repositories exist
  ls -d harness-eso x79
  ```
- **Port allocation** for multi-tenant Observatory instances:
  - **`8792`**: **`x79`** (primary golden consumer)
  - **`8793`**: `baplatform` (BA Platform)
  - **`8794`**: `FinESO`
- **AgentMemory instance** for x79 listening on port **`3111`** (Viewer on **`3113`**).

---

## 2. Initialise Harness‑ESO in `x79`

From `harness-eso`, run the initialization command specifying the target root, consumer ID, and port:

```bash
# Navigate to harness-eso root
cd ~/Workspaces/harness-eso

# Apply provisioning (dual-IDE support: Cursor + Antigravity)
node packages/harness-cli/src/cli.mjs init profile ../x79 --id x79 --port 8792
```

This operation updates and synchronizes:
- `x79/.harness/host-pack/` (`harness-hook.mjs`, `route-hook.py`, `path-policy.default.json`)
- `x79/.harness/decision-policy.json` (merged with Token-Diet & Cognition gate)
- `x79/.harness/host-bootstrap.json` & `sidecar.env`
- `x79/.cursor/hooks.json` & `.agents/hooks.json`

---

## 3. Align Port Tenancy (Port 8792)

Ensure `harness.config.json` and sidecar files reflect port `8792`:

```json
{
    "version": 1,
    "project": {
        "id": "x79",
        "displayName": "x79"
    },
    "server": {
        "host": "127.0.0.1",
        "port": 8792
    }
}
```

Verify `.harness/sidecar.env`:
```ini
HARNESS_SIDECAR_URL=http://127.0.0.1:8792
HARNESS_OBSERVE_URL=http://127.0.0.1:8792
HARNESS_REPO_ROOT=/Users/thangs2net/Workspaces/x79
```

---

## 4. MCP & Recon Tools Configuration

For architectural details on pre-turn reconnaissance sequencing and cognition gates, see [Recon Trinity & Cognition Flows](./06.recon-and-cognition-flows.md).

### A. Cursor MCP (`.cursor/mcp.json`)
x79 uses **global CLI for Docgraph** (avoiding stdio daemon crashes and eliminating `@modelcontextprotocol/sdk` dependencies). The MCP configuration only registers servers that require persistent protocol streams:

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
        "AGENTMEMORY_URL": "http://localhost:3111",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3113"
      }
    },
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": [
        "serve",
        "--mcp",
        "--path",
        "/Users/thangs2net/Workspaces/x79"
      ]
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
    },
    "penpot-write": {
      "url": "https://design.penpot.app/mcp/stream?userToken=...",
      "type": "http"
    },
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v2/mcp"
    }
  }
}
```

### B. Antigravity MCP (`.agents/mcp_config.json`)

> [!CAUTION]
> **IDE Isolation Invariant:**  
> `.agents/` and `.cursor/` are two strictly independent configuration trees. **Cross-referencing paths between them (A → B or B → A) is strictly prohibited**.  
> Specifically: `.agents/mcp_config.json` must never reference or execute script files located inside `.cursor/mcp/` and vice versa. Each IDE manages its own MCP runtime configuration independently.

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
        "AGENTMEMORY_URL": "http://localhost:3111",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3113"
      }
    },
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": [
        "serve",
        "--mcp"
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
    },
    "penpot-write": {
      "type": "http",
      "serverUrl": "https://design.penpot.app/mcp/stream?userToken=..."
    },
    "atlassian": {
      "command": "/opt/homebrew/bin/bunx",
      "args": [
        "-y",
        "@rokealvo/jira-mcp"
      ],
      "env": {
        "JIRA_BASE_URL": "https://thangs2net.atlassian.net",
        "JIRA_USER_EMAIL": "thangs2.net@gmail.com",
        "JIRA_API_TOKEN": "...",
        "JIRA_TYPE": "cloud",
        "JIRA_AUTH_TYPE": "basic",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

### C. Docgraph CLI Integration
- Local index resides in `x79/.docgraph/`.
- Both IDE environments (Cursor and Antigravity) use the shared **global CLI** `docgraph` without requiring an MCP daemon.
- Re-index command:
  ```bash
  cd ~/Workspaces/x79 && docgraph build
  ```
- Query command:
  ```bash
  docgraph --q "<search_terms>"
  ```

---

## 5. Token-Diet Conformance Verification

x79 adheres to **STD-ESO-PERF-01**:

| Metric | Budget | x79 Status |
|---|---|---|
| **Eager Rules Count** | $\le 7$ | **Conforms** |
| **Eager Prefix Tokens** | $\le 5,000$ | **Conforms** |
| **Frontmatter Integrity** | 0 conflicts | **PASS** |
| **Lazy Globs Integrity** | 0 missing | **PASS** |

### Guidelines:
* Core router, pipeline gate, and knowledge cards retain `alwaysApply: true`.
* Domain-specific rules (angular, nestjs, ef-core, jira) must set `alwaysApply: false` with specific `globs:`.

---

## 6. Verification & Health Check

To verify the installation on `x79`:

1. Run the Token-Diet auditor:
   ```bash
   node -e "import('@mu/harness-foundation/token-diet').then(m => console.log(m.scanTokenDiet('../x79')))"
   ```
2. Verify preflight execution:
   ```bash
   cd ~/Workspaces/x79
   node .harness/host-pack/harness-hook.mjs preflight
   cat .cursor/session/.eso-preflight.json
   ```
3. Verify write-guard:
   ```bash
   python3 .cursor/hooks/guard-write.py AGENTS.md
   # Expected: blocked unless valid attestation is present
   ```
