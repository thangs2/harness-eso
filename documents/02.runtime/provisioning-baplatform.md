# Provisioning BA Platform with Harness‑ESO

*Last updated: 2026‑10‑15*

---

## Overview
This runbook describes the **production-grade, step‑by‑step provisioning** needed to integrate the **Harness‑ESO** stack (`@mu/harness-*`) into the **BA Platform** repository (`baplatform`).

> [!IMPORTANT]
> **Working Directory Discipline:**  
> - Commands that manage product profiles (`./harness init profile`, `./docker/observatory.sh`) must be run from `harness-eso`.
> - Commands that inspect/edit repo files, test hooks, or run local checks must be run from inside `baplatform` (`cd ~/Workspaces/baplatform`).  
> **Never** execute consumer hooks (`.harness/host-pack/harness-hook.mjs`) when your shell's working directory is `harness-eso`—doing so will cause runtime session files (`.eso-preflight.json`) to leak into the product repository.

---

## 1. Prerequisites
- **Node ≥ 20**, **Bun** installed on host.
- **Docker Desktop / Engine** running (for the Observatory dashboard & AgentMemory).
- Sibling clone topology in the workspace directory (e.g. `~/Workspaces`):
  ```bash
  cd ~/Workspaces
  # verify both repositories exist
  ls -d harness-eso baplatform
  ```
- **Port allocation** for multi-tenant Observatory instances:
  - **`8792`**: `x79` (primary consumer)
  - **`8793`**: **`baplatform`** (BA Platform)
  - **`8794`**: `FinESO`
- **AgentMemory container** for BA Platform listening on port **`3211`** (container `baplatform-agentmemory`).

---

## 2. Archive Legacy Harness Artifacts from `baplatform`

Before provisioning Node-based hooks, archive legacy Python monitor tools and remove obsolete route scripts from `baplatform`:

```bash
# Navigate to baplatform root
cd ~/Workspaces/baplatform

# 1. Archive legacy tooling
mkdir -p archive/legacy/harness
mv tools/harness archive/legacy/harness/ 2>/dev/null || true
mv tools/monitors/harness archive/legacy/harness/monitors-harness 2>/dev/null || true

# 2. Remove obsolete route scripts & legacy lock files (DO NOT remove guard-write.py or guard-shell.py!)
rm -f .cursor/hooks/locked-paths.txt \
      .agents/hooks/locked-paths.txt \
      .agents/hooks/harness-route-hook.sh
```

> [!WARNING]
> **Do NOT delete `guard-write.py` or `guard-shell.py`!**  
> In the dual-IDE setup, Python guards remain the active fail-closed write-gate and shell-gate invoked by Cursor (`preToolUse`) and Antigravity (`pre-tool-use.py`).

---

## 3. Initialise Harness‑ESO in `baplatform`

Switch to `harness-eso` to preview and apply the profile:

```bash
# Navigate to harness-eso root
cd ~/Workspaces/harness-eso

# 1. Preview the provisioning plan (dry run - writes nothing)
./harness init profile ../baplatform --id baplatform --plan

# 2. Apply provisioning (dual-IDE support: Cursor + Antigravity)
./harness init profile ../baplatform --id baplatform --host-mode dual-ide
```

This operation generates:
- `baplatform/.harness/host-pack/` (`harness-hook.mjs`, `route-hook.py`, `path-policy.default.json`)
- `baplatform/.harness/decision-policy.json` (merged with Token-Diet & Cognition gate)
- `baplatform/.harness/host-bootstrap.json` & `sidecar.env`
- `baplatform/.cursor/hooks.json` & `.agents/hooks.json`

---

## 4. Align Port Tenancy (Port 8793)

Because `./harness init profile` defaults to port `8792`, you **must** align BA Platform's local configuration to port **`8793`** to prevent collisions with `x79`.

Run the following script inside `baplatform`:

```bash
cd ~/Workspaces/baplatform

node -e '
import fs from "fs";

// 1. Update harness.config.json
const cfgFile = "harness.config.json";
if (fs.existsSync(cfgFile)) {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.server = cfg.server || {};
    cfg.server.port = 8793;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 4));
}

// 2. Update .harness/sidecar.env
const envFile = ".harness/sidecar.env";
if (fs.existsSync(envFile)) {
    let env = fs.readFileSync(envFile, "utf8");
    env = env.replace(/8792/g, "8793");
    fs.writeFileSync(envFile, env);
}

// 3. Update .harness/host-bootstrap.json
const bootFile = ".harness/host-bootstrap.json";
if (fs.existsSync(bootFile)) {
    let boot = fs.readFileSync(bootFile, "utf8");
    boot = boot.replace(/8792/g, "8793");
    fs.writeFileSync(bootFile, boot);
}

// 4. Update .harness/WORKFLOW_GUIDE.md if present
const guideFile = ".harness/WORKFLOW_GUIDE.md";
if (fs.existsSync(guideFile)) {
    let guide = fs.readFileSync(guideFile, "utf8");
    guide = guide.replace(/8792/g, "8793");
    fs.writeFileSync(guideFile, guide);
}

console.log("Port aligned to 8793 across all configuration files.");
'
```

---

## 5. Enable Jev (L2) & DeepSeek Flash Route (L3) in `integrations.json` & `decision-policy.json`

By default, the baseline profile initializes with System 1 Jev (L2) and Flash route (L3) turned `off`. Since `baplatform` already has:
- A valid TypeSafe API key in `installation/typesafe/typesafe.env` (`TYPESAFE_API_KEY`)
- DeepSeek configured for L3 Flash routing and System 2 Brain execution
- Dedicated AgentMemory container (`baplatform-agentmemory`) running on port `3211`

You must configure `.harness/integrations.json` and sync `.harness/decision-policy.json` to activate:
1. **L2 Jev (TypeSafe)**: Set adapter to `jev-typesafe-active` with `mode: "active"` (or `jev-typesafe-shadow` for audit-only mode).
2. **L3 Flash Route**: Set adapter to `deepseek-flash-route` (`fallback.l3_flash: true`).
3. **Memory Adapter**: Set adapter to `agentmemory-mcp`.

Run the following script inside `baplatform`:

```bash
cd ~/Workspaces/baplatform

node -e '
import fs from "fs";

// 1. Update .harness/integrations.json
const intFile = ".harness/integrations.json";
if (fs.existsSync(intFile)) {
    const data = JSON.parse(fs.readFileSync(intFile, "utf8"));
    data.memory = { adapterId: "agentmemory-mcp" };
    data.jev = { adapterId: "jev-typesafe-active", mode: "active" };
    data.l3_route = { adapterId: "deepseek-flash-route" };
    data.brain = { adapterId: "deepseek-mcp" };
    fs.writeFileSync(intFile, JSON.stringify(data, null, 4));
}

// 2. Synchronize .harness/decision-policy.json
const polFile = ".harness/decision-policy.json";
if (fs.existsSync(polFile)) {
    const policy = JSON.parse(fs.readFileSync(polFile, "utf8"));
    policy.jev = policy.jev || {};
    policy.jev.mode = "active";
    policy.fallback = policy.fallback || {};
    policy.fallback.l3_flash = true;
    fs.writeFileSync(polFile, JSON.stringify(policy, null, 4));
}

console.log("Integrations and decision-policy updated: Jev active, L3 Flash on, AgentMemory enabled.");
'
```

> [!NOTE]
> `harness-hook.mjs` automatically loads `TYPESAFE_API_KEY` from `installation/typesafe/typesafe.env` if not exported in shell environment.

---

## 6. Lock Sacred Governance Paths in `decision-policy.json`

In Harness-ESO, path protection is managed centrally through `.harness/decision-policy.json`. `guard-write.py` reads `paths.locked` from this file.

Update `baplatform/.harness/decision-policy.json` to lock BA Platform's Source of Truth and core operating laws:

```bash
cd ~/Workspaces/baplatform

node -e '
import fs from "fs";
const file = ".harness/decision-policy.json";
if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.paths = data.paths || {};
    data.paths.locked = [
        "docs/",
        "sdlc/00.governance/01.source-of-truth/",
        ".cursor/rules/core.ap-platform.mdc",
        ".cursor/rules/sdlc.gov.operating-model.mdc"
    ];
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
    console.log("Sacred paths successfully locked in decision-policy.json.");
}
'
```

---

## 7. Verify & Synchronize Dual-IDE Hook Configurations

Ensure legacy hook references are purged and Antigravity's `harness-tracer` executes the Python pre-tool gate:

```bash
cd ~/Workspaces/baplatform

node -e '
import fs from "fs";

// 1. Clean & verify .cursor/hooks.json
const cursorFile = ".cursor/hooks.json";
if (fs.existsSync(cursorFile)) {
    const data = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    for (const [event, list] of Object.entries(data.hooks || {})) {
        data.hooks[event] = list.filter(h => !h.command.includes("tools/") && !h.command.includes("harness-route-hook.sh"));
        if (data.hooks[event].length === 0) delete data.hooks[event];
    }
    fs.writeFileSync(cursorFile, JSON.stringify(data, null, 4));
}

// 2. Clean & synchronize .agents/hooks.json
const agentsFile = ".agents/hooks.json";
if (fs.existsSync(agentsFile)) {
    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    delete data["guard-write"];
    delete data["guard-shell"];
    delete data["harness-checkpoint"];
    
    // Wire pre-tool-use.py so Antigravity enforces guard-write and guard-shell
    data["harness-tracer"] = {
        "PreToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": "python3 .agents/hooks/pre-tool-use.py"
                    }
                ]
            }
        ]
    };
    fs.writeFileSync(agentsFile, JSON.stringify(data, null, 4));
}
console.log("Dual-IDE hooks synchronized and verified.");
'
```

---

## 8. Provision MCP Configurations for Both IDEs

Both Cursor and Antigravity require project-level MCP configurations to access `agentmemory` (port `3211`), `codegraph`, and `deepseek-direct`. For detailed reconnaissance ordering and execution matrix, refer to [Recon Trinity & Cognition Flows](./06.recon-and-cognition-flows.md).

> [!NOTE]
> **Docgraph Architecture:**  
> `docgraph` executes via the **global CLI** (`docgraph --q "<terms>"`), not via an MCP server. This eliminates the `@modelcontextprotocol/sdk` runtime dependency and completely eliminates stdio daemon disconnect risks.

### 8.1 Cursor MCP Configuration (`.cursor/mcp.json`)
Create `baplatform/.cursor/mcp.json`:

```bash
cd ~/Workspaces/baplatform

cat <<'EOF' > .cursor/mcp.json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": [
        "-y",
        "@agentmemory/mcp"
      ],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3211",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3213"
      }
    },
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": [
        "serve",
        "--mcp",
        "--path",
        "/Users/thangs2net/Workspaces/baplatform"
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
      "url": "https://design.penpot.app/mcp/stream?userToken=eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.ROHKoaWEL0Tl7cJb8iJdnEDtGm1t_qk5xtC9aDk0aYhDXgPg2LeFvg.8KHdSugvQEvIffi7.2mUEK0H65e_OxJSKq4X5Lk__q22eDxGTdO22RuGlIQ93Dz0ZKx7uBoFG4SeoQV_1tyHuRbC8NHnGzmakDESQDx25KdSblszC28sktGMdvlmSbeBliy-Hbo1t_8n7bTBFI1-waeG0SV5MWwCwMM5e9KvjSrA1hHTAj7EAAUW6IUQ6SGwMV4Pf9J7bM67UMSyVEdKxcBJ4-au6.6zsLlmt9hzJ1hC4-ciXJ5Q",
      "type": "http"
    },
    "jira": {
      "command": "/opt/homebrew/bin/bunx",
      "args": [
        "-y",
        "@rokealvo/jira-mcp"
      ],
      "env": {
        "JIRA_BASE_URL": "https://thangs2net.atlassian.net",
        "JIRA_USER_EMAIL": "thangs2.net@gmail.com",
        "JIRA_API_TOKEN": "ATATT3xFfGF01auvw5brvuRK1xDCdKvdp0lOymbSdFHzHqq-wVwIvYq2bA8ry5rVtRCW-nTXAWf1D2LgxUVJdYpXJvEmVvs7NVV7IGDfZCoLLzb4lY2wFMELjCyXtzqtFah00Wyo4WxDMPK_TWQSfPwo3vxO6WrT6_VXUNxjXlvzsFJAgQUe7V8=4C8F85C8",
        "JIRA_TYPE": "cloud",
        "JIRA_AUTH_TYPE": "basic",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
EOF
```

### 8.2 Antigravity MCP Configuration (`.agents/mcp_config.json`)

> [!CAUTION]
> **IDE Isolation Invariant:**  
> `.agents/` and `.cursor/` are two strictly independent configuration trees. **Cross-referencing paths between them (A → B or B → A) is strictly prohibited**.  
> Specifically: `.agents/mcp_config.json` must never reference or execute script files located inside `.cursor/mcp/` and vice versa. Each IDE manages its own MCP runtime configuration independently.

Create `baplatform/.agents/mcp_config.json`:

```bash
cat <<'EOF' > .agents/mcp_config.json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": [
        "-y",
        "@agentmemory/mcp"
      ],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3211",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3213"
      }
    },
    "codegraph": {
      "command": "/opt/homebrew/bin/codegraph",
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
      "serverUrl": "https://design.penpot.app/mcp/stream?userToken=eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.ROHKoaWEL0Tl7cJb8iJdnEDtGm1t_qk5xtC9aDk0aYhDXgPg2LeFvg.8KHdSugvQEvIffi7.2mUEK0H65e_OxJSKq4X5Lk__q22eDxGTdO22RuGlIQ93Dz0ZKx7uBoFG4SeoQV_1tyHuRbC8NHnGzmakDESQDx25KdSblszC28sktGMdvlmSbeBliy-Hbo1t_8n7bTBFI1-waeG0SV5MWwCwMM5e9KvjSrA1hHTAj7EAAUW6IUQ6SGwMV4Pf9J7bM67UMSyVEdKxcBJ4-au6.6zsLlmt9hzJ1hC4-ciXJ5Q"
    },
    "jira": {
      "command": "/opt/homebrew/bin/bunx",
      "args": [
        "-y",
        "@rokealvo/jira-mcp"
      ],
      "env": {
        "JIRA_BASE_URL": "https://thangs2net.atlassian.net",
        "JIRA_USER_EMAIL": "thangs2.net@gmail.com",
        "JIRA_API_TOKEN": "ATATT3xFfGF01auvw5brvuRK1xDCdKvdp0lOymbSdFHzHqq-wVwIvYq2bA8ry5rVtRCW-nTXAWf1D2LgxUVJdYpXJvEmVvs7NVV7IGDfZCoLLzb4lY2wFMELjCyXtzqtFah00Wyo4WxDMPK_TWQSfPwo3vxO6WrT6_VXUNxjXlvzsFJAgQUe7V8=4C8F85C8",
        "JIRA_TYPE": "cloud",
        "JIRA_AUTH_TYPE": "basic",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
EOF
```

### 8.3 Docgraph CLI Integration
- Local index resides at `baplatform/.docgraph/`.
- Both IDE environments (Cursor and Antigravity) use the shared **global CLI** `docgraph` instead of an MCP daemon.
- Re-index command:
  ```bash
  cd ~/Workspaces/baplatform && docgraph build
  ```
- Query command:
  ```bash
  docgraph --q "<search_terms>"
  ```

---

## 9. Token-Diet Optimization (Eager Rules Taming)

Harness-ESO enforces a Token-Diet budget:
- **`maxEagerRules`**: `7`
- **`maxEagerTokens`**: `5000`

If your project has 15 rules with `alwaysApply: true`, it inflates prompt turns by **>23,000 tokens**.

To comply with the budget:
1. Keep `alwaysApply: true` strictly for **core router and pipeline law rules**:
   - `core.pipeline-gate.mdc`
   - `core.ap-platform.mdc`
   - `core.codegraph.mdc`
   - `core.scope-fallback.mdc`
   - `brain.knowledge-card.mdc`
2. Change heavy delivery/workflow rules (`delivery.jira.mdc`, `delivery.workflow.mdc`, `sdlc.gov.*.mdc`) to `alwaysApply: false`. They will be loaded on demand via file globs or Docgraph/AgentMemory without burning static context.

---

## 10. Test Hook Execution Locally

> [!CAUTION]
> **Must run inside `baplatform`!** Ensure your current working directory is `baplatform`.

```bash
cd ~/Workspaces/baplatform

# Test Preflight hook for Cursor
echo "{}" | node .harness/host-pack/harness-hook.mjs --hook preflight --tree cursor

# Test Preflight hook for Antigravity
echo "{}" | node .harness/host-pack/harness-hook.mjs --hook preflight --tree agents
```

**Expected output:**
A JSON object indicating preflight status (e.g. `{"permission":"allow","esoPreflight":{"level":...}}`). Runtime stamps are saved strictly into `baplatform/.cursor/session/`.

---

## 11. Register & Start Observatory on Port 8793

### Register in Workspace Registry (`~/.harness/workspace.json`)
Ensure `baplatform` is mapped to port `8793`:
```bash
node -e '
import fs from "fs";
import os from "os";
import path from "path";
const file = path.join(os.homedir(), ".harness", "workspace.json");
if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    let found = false;
    for (const p of data.projects) {
        if (p.id === "baplatform") { p.port = 8793; found = true; }
    }
    if (!found) {
        data.projects.push({
            id: "baplatform",
            displayName: "BA Platform",
            root: path.resolve(process.env.HOME + "/Workspaces/baplatform"),
            rootHost: path.resolve(process.env.HOME + "/Workspaces/baplatform"),
            port: 8793,
            profile: "generic-eso",
            initProfile: true
        });
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
    console.log("workspace.json configured for baplatform on port 8793");
}
'
```

### Start Docker Stack
From `harness-eso`:
```bash
cd ~/Workspaces/harness-eso

# Start baplatform stack on port 8793
HARNESS_OBSERVE_PORT=8793 ./docker/observatory.sh up ~/Workspaces/baplatform --no-build
```

### Health Check
```bash
curl -s http://127.0.0.1:8793/health | jq
```
Expected: `{"ok":true,"degraded":false,...}`.

Dashboard is accessible at: **[http://127.0.0.1:8793/requests](http://127.0.0.1:8793/requests)**.

---

## 12. Commit Changes in `baplatform`

```bash
cd ~/Workspaces/baplatform

git status -s
git add .harness/ harness.config.json .cursor/ .agents/ archive/
git commit -m "feat(harness): provision latest Harness-ESO stack with dual-IDE support (port 8793)"
```


