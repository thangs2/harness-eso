---
description: harness-eso — ship @mu/harness-* (observe, Observatory, CLI). Consumer verify on x79.
layer: core
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
globs: packages/**,docker/**,qc/**,profiles/**,compose.harness.yml,install.sh,harness,docs/**
---

# Harness ESO — product repo (harness-eso)

**Workspace root:** this monorepo only. **Do not** apply `mu-bible`, NestJS mu-*, or Angular stack rules here.

## Boundary

| Work here | Verify / mount on **consumer** (usually **x79**) |
|-----------|--------------------------------------------------|
| `packages/harness-observe-server`, `harness-observatory`, `harness-cli`, … | `HARNESS_REPO_ROOT` → consumer with `harness.config.json` |
| `docker/observatory.ps1` · `observatory.sh` · `observatory.Dockerfile` | http://127.0.0.1:8792 after `up` |
| `qc/*`, `bun test`, `bun run build:observatory` | `./docker/observatory.sh smoke` with consumer mounted |

**Spec / WBS (read):** sibling `../x79/document/harness/02.harness-eso/` (x79 repo — not copied into harness-eso). Use Read, docgraph with x79 path, or clone x79 beside this repo.

**Not in this repo:** MSX `backend/mu-*`, `frontend/`, consumer `.harness/decision-policy.json` (lives on x79).

## Commands

```bash
bun install
bun test
bun run build:observatory
bun run test:observatory
```

Docker (operator): **`docker/observatory.ps1`** (Windows) or **`docker/observatory.sh`** (macOS/Linux) — no `observe.sh` symlink.

## Agent

Chain: **`core.law-gate`** → Read **`AGENTS.md`** → isolation → agents pipeline (this file). Skills **only** `.cursor/skills/harness-*`. MCP: **`.cursor/mcp.json`** (`docs/03.cursor-mcp.md`).

Codegraph MCP indexes **this** repo. Consumer ingest/transcripts → `codegraph_explore` `projectPath` **x79** (read-only).
