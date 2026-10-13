# harness-eso

Monorepo for **Harness Evidence Sufficiency Orchestrator** — npm scope [`@mu/harness-*`](https://github.com/thangs2/harness-eso).

| | |
|---|---|
| **Git** | [github.com/thangs2/harness-eso](https://github.com/thangs2/harness-eso) |
| **Product docs (SoT)** | [x79 `document/harness/02.harness-eso/`](https://github.com/thangs2/x79/tree/main/document/harness/02.harness-eso) (sibling clone `../x79`) |
| **Operator config** | `harness-eso/.harness/workspace.json` (local, gitignored) |
| **Agent runtime** | **Only** `./harness init profile <consumer-path>` writes `harness.config.json`, `.harness/*`, and host hook merge on consumer (e.g. `../x79`) — not by hand, not `configure add` |

## Install

Work **only inside** your `harness-eso` clone after `git clone`:

```bash
git clone https://github.com/thangs2/harness-eso.git
cd harness-eso
./install.sh
./harness up
```

→ **http://127.0.0.1:8792/projects** — thêm dự án, mở repo agent trong IDE. [docs/00.getting-started.md](./docs/00.getting-started.md).

## Layout

```text
packages/
  harness-foundation/   # W1 — repo root, paths, policy load
profiles/
  generic-eso.json      # greenfield default policy sample
```

## Run observe

Link a consumer (full host pack), then observe:

```bash
./harness init profile /path/to/x79 --id x79 --host-mode dual-ide
./harness up
```

Plan only (no writes): `./harness init profile <path> --plan`

Docker image & compose: [docker/README.md](./docker/README.md) · CLI: `packages/harness-cli/src/observe-cmd.mjs`.

## Develop (monorepo contributors — Bun on host)

Preferred package manager: **Bun** (workspaces + lockfile).

```bash
bun install
bun test                    # node:test spine (foundation, qc, system-one)
bun run build:observatory   # W5 Vite SPA
bun run test:observatory    # Vitest — ConsentGateCard
bun run dev:observe         # API on :8792 + Vite on :5190 (no Docker)
bun run dev:observatory     # Vite only (proxies /api → observe-server :8792)
bun run build:observatory   # before bundled UI from observe-server
node packages/harness-observe-server/src/server.mjs --root ../x79
```

Observe-server (W4++) serves full REST per `15.observe-api-contract.md`, polls ingest, and hosts Observatory `dist/` at `/` when built.

Point at a repo with `harness.config.json` (e.g. `../x79`) when testing integration.

## WBS

Implementation waves: x79 `document/harness/02.harness-eso/13.implementation-wbs.md`.
