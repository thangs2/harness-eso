# Provisioning BA Platform with Harness‑ESO

*Last updated: 2026‑10‑15*

---

## Overview
This document describes the **step‑by‑step provisioning** needed to integrate the **latest `harness‑eso`** stack into the **BA Platform** repository (`baplatform`).
It assumes you have a clean checkout of both repos and that `harness‑eso` is at its current version.

---

## 1. Prerequisites
- Node ≥ 20, Bun (for the monorepo) installed.
- Docker (for the observatory UI, optional for CI).
- Access to the `baplatform` repo on the same filesystem:
  ```bash
  cd /Users/thangs2net/Workspaces
  # you should see both repos
  ls -d harness-eso baplatform
  ```
- Environment variables:
  - `HARNESS_CURSOR_MOUNT` (optional – only needed for tests that simulate a missing cursor mount).

---

## 2. Remove Legacy Harness Artifacts from `baplatform`
```bash
# From the baplatform root
cd ../baplatform
# Archive legacy code (optional) – you can delete instead
mkdir -p archive/legacy/harness
mv tools/harness archive/legacy/harness/
mv tools/monitors/harness archive/legacy/harness/
# Remove old hook scripts
rm -f .agents/hooks/guard-write.py .agents/hooks/guard-shell.py
rm -f .agents/hooks/locked-paths.txt .cursor/hooks/guard-write.py .cursor/hooks/guard-shell.py
```
> **Why?** These files are superseded by the Node‑based hooks shipped with `harness‑eso`. Keeping them would confuse `codegraph`/`docgraph` and inflate token usage.

---

## 3. Initialise Harness‑ESO in `baplatform`
```bash
# From the harness‑eso root (still in the workspace)
cd ../harness-eso
# Initialise a profile that points to the baplatform repo
./harness init profile ../baplatform --id baplatform
```
The command creates:
- `baplatform/harness.config.json`
- `baplatform/.harness/decision-policy.json`
- `.agents/hooks.json` and `.cursor/hooks.json`
- Session directories (`.agents/session`, `.cursor/session`).
- Host‑pack with the new Node‑based hooks (`guard‑brain‑hook.mjs`, `guard‑shell‑hook.mjs`).

---

## 4. Update Configuration Files
### 4.1 `harness.config.json`
```json
{
  "version": 1,
  "project": { "id": "baplatform", "displayName": "BA Platform" },
  "tracking": { "enabled": true, "sentinelPath": ".harness/DISABLED" },
  "storage": { "driver": "sqlite", "sqlite": { "path": ".harness/harness.db" } },
  "server": { "host": "127.0.0.1", "port": 8792 },
  "ingest": { "pollMs": 2000, "harnesses": [
    { "id": "cursor", "tree": ".cursor", "shape": "cursor", "spine": "jsonl-transcript" },
    { "id": "agents", "tree": ".agents", "shape": "antigravity", "spine": "jsonl-transcript" }
  ] },
  "tenancy": { "mode": "isolated", "registry": "~/.harness/tenants.json" }
}
```
> Ensure the `port` matches the observatory UI (`8792`).

### 4.2 `decision-policy.json`
Add **Token‑Diet** and **Cognition** blocks (already present in the latest generic‑eso profile, but double‑check):
```json
{
  "version": 1,
  "profile": "promax",
  "jev": { "mode": "active", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" },
  "fallback": { "l3_flash": true, "l3_model": "deepseek-flash" },
  "tokenDiet": { "enabled": true, "maxEagerRules": 6, "maxEagerTokens": 5000 },
  "cognition": { "enforceBrain": "fail_closed", "gapAttestation": true },
  "eso": {
    "enabled": true,
    "mode": "hint",
    "enforceWrites": "fail_closed",
    "preflight": { "enabled": true, "jevOnPartial": true, "maxMs": 7000 },
    "thresholds": { "T_low": 0.45, "T_high": 0.72 },
    "memoryFetch": true
  }
}
```
---

## 5. Verify Hook Integration
```bash
# From the baplatform root
cd ../baplatform
# Run a quick health check (the observatory will be started automatically)
node ./tools/observatory/src/verify-eso.mjs   # or use the built‑in test
curl http://127.0.0.1:8792/health | jq
```
Expected output (when the transcript directory exists):
```json
{ "ok": true, "degraded": false, "ingestSpine": { "spineOk": true, "transcriptDirExists": true, "transcriptFiles": 0, "warnings": [] } }
```
When the transcript directory is missing you should see `degraded: true` and `spineOk: false` – the same behavior verified by `observe‑spine‑health.test.mjs`.

---

## 6. Adjust Rules & CI
1. **Remove references** to legacy `tools/harness` in:
   - `.agents/rules/*`
   - `.cursor/rules/*`
2. **Add a comment** to `core.pipeline-gate.mdc` stating that policy is now sourced from `.harness/decision-policy.json`.
3. **Update CI scripts** to start the observatory on port 8792 instead of the old `ctl.sh` script:
   ```bash
   # In .github/workflows/ci.yml (or local scripts)
   ./harness up &   # runs in background
   ```
4. **Add a shortcut script** in `baplatform/scripts`:
   ```bash
   #!/usr/bin/env bash
   # scripts/harness-init.sh
   cd $(dirname "$0")/..
   ./harness init profile . --id baplatform
   ```
   Make it executable (`chmod +x scripts/harness-init.sh`).

---

## 7. Final Sanity Test
Run the full QC suite of `harness‑eso` against the freshly‑provisioned `baplatform`:
```bash
cd ../harness-eso
bun test qc/**/*.test.mjs
```
All tests should pass, including `observe-spine-health.test.mjs` (lines 34‑85) which validates the health endpoint.

---

## 8. Commit & Share
```bash
cd ../baplatform
git add .harness harness.config.json .agents/hooks.json .cursor/hooks.json docs/provisioning-baplatform.md
git commit -m "Provision BA Platform with latest Harness‑ESO (port 8792, token‑diet, brain‑gate)"
git push origin <your‑branch>
```

---

## 9. Reference Links
- **Harness‑ESO repo:** [harness‑ESO](file:///Users/thangs2net/Workspaces/harness-eso)
- **BA Platform repo:** [baplatform](file:///Users/thangs2net/Workspaces/baplatform)
- **Health endpoint spec:** see `observe-spine-health.test.mjs` (lines 34‑85).

---

*Document generated on 2026‑10‑15 by Antigravity agent.*
