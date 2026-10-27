# harness-eso

Monorepo for **Harness Evidence Sufficiency Orchestrator** — npm scope [`@mu/harness-*`](https://github.com/thangs2/harness-eso).

A control and observation layer that runs **around** an AI coding agent in an IDE: it gates the agent's
writes on evidence, attributes every action to a turn, and serves a read-only monitor.

| | |
|---|---|
| **Git** | [github.com/thangs2/harness-eso](https://github.com/thangs2/harness-eso) |
| **Deep Product Intro & Who It's For** | [`documents/01.overview/04.introduction-and-audience.md`](documents/01.overview/04.introduction-and-audience.md) — philosophy, architecture pillars, target audience |
| **Complete User & Operator Guide** | [`documents/01.overview/05.user-and-operator-guide.md`](documents/01.overview/05.user-and-operator-guide.md) — step-by-step setup, policy, daily IDE workflows & Observatory |
| **Documentation Index (read first)** | [`documents/00.README.md`](documents/00.README.md) — what the system is and how it works |
| **Invariants** | [`documents/05.development/02.invariants.md`](documents/05.development/02.invariants.md) — **read before changing how data flows** |
| **Defect log** | [`docs/04.standalone-revamp-wbs.md`](docs/04.standalone-revamp-wbs.md) — measured history, every `F<n>` |
| **Operator runbooks** | `docs/00`–`docs/07` · Docker: [`documents/04.operations/02.docker-deploy.md`](documents/04.operations/02.docker-deploy.md) |
| **Operator config** | `~/.harness/workspace.json` (machine-wide product state) |

> **Picking this project up cold?** Read `documents/00.README.md`, then the invariants. Each invariant
> names the production defect that produced it, so they are not style preferences.

This repository **ships** the product. It is not a consumer of it: do not run the ESO pipeline on
`harness-eso` itself, and do not provision it — provisioning writes agent hooks, and writing them into
the repo that ships them is a loop the planner refuses.

## Prerequisites

Before installing, ensure your host environment meets the following requirements:

* **Bun** (`>= 1.1`) — primary package manager and test runner for monorepo development (`bun install`, `bun test`).
* **Node.js** (`>= 20` LTS) — required runtime for standalone host pack hooks (`node:fs`, `node:crypto`) and CLI.
* **Python 3** (`>= 3.9`) — required for consumer-side guard and tracer scripts (`guard-write.py`, `guard-shell.py`, `route-hook.py`).
* **Docker & Docker Compose** (`>= v2`) — required for containerized Observatory monitor (`:8792`) and Console wizard (`:8791`).
* **Git** (`>= 2.30`) — version control.
* **Supported Platforms:** macOS (Apple Silicon / Intel), Linux (x86_64 / arm64), Windows (WSL2 / PowerShell).

*(Optional — Recon & Cognition ecosystem for consumer repos)*:
* **`docgraph` CLI** — for spec and invariant evidence retrieval.
* **`codegraph` MCP** — for AST and symbol call hierarchy exploration.
* **`agentmemory` MCP** — for cross-session long-term institutional memory.
* **DeepSeek API Key** (`deepseek-direct` MCP) — Brain tier for deep reasoning (`ask_deepseek_flash` / `ask_deepseek_pro`).
* **TypeSafe Jev API Key** (`TYPESAFE_API_KEY`) — if Jev System One route tie-breaking is enabled (`shadow` or `active`).

## Install

```bash
git clone https://github.com/thangs2/harness-eso.git
cd harness-eso
./install.sh          # bun install + make ./harness, ./console.sh executable
./harness up          # build image + compose up
```

→ **http://127.0.0.1:8792** — Projects tab to add a consumer. See
[`documents/04.operations/01.install-and-provision.md`](documents/04.operations/01.install-and-provision.md).

## Provision a consumer

A **consumer** is a repo the product is installed into. It must live **outside** this checkout.

```bash
harnessctl init profile /path/to/consumer --plan            # dry run — writes nothing
harnessctl init profile /path/to/consumer --id <id> --host-mode dual-ide
harnessctl host-pack status /path/to/consumer               # expect integrity ok, verification ok
./verify-consumer.sh <id>                                      # maturity diagnostic → .harness/diagnostics/
./fix-consumer.sh <id>                                         # semi-auto safe remediations + OPEN_FIXES.md
# then reload the IDE window — required, the IDE caches hooks.json at window open
```

`./harness init profile …` is the same command. Full flag reference:
[`documents/04.operations/03.cli-reference.md`](documents/04.operations/03.cli-reference.md).

## Layout

```text
packages/
  harness-foundation/       shared vocabulary: paths, policy, path policy, consent, attest, shell-writes
  harness-eso-core/         evidence: collect → gaps → score → gate
  harness-decision/         decision facade L0–L3 + ledger
  harness-system-one/       Jev HTTP client
  harness-host-generic/     the host pack — bundled hooks injected into a consumer
  harness-observe-server/   :8792 — REST + SSE + ingest worker
  harness-observatory/      the monitor SPA (read-only)
  harness-console-server/   :8791 — project management API (the write side)
  harness-console/          the setup wizard SPA
  harness-cli/              harnessctl
profiles/
  generic-eso.json          consumer policy seed (mechanism-generic)
  host/*.json               per-IDE hook wiring (cursor-superset, agents-superset)
observatory.Dockerfile      observe image (Bun + SPA + observe-server)
console.Dockerfile          console image (wizard API + SPA, :8791)
compose.harness.yml         observe stack — one container per project id
compose.console.yml         console stack (:8791)
console.sh                  console deploy / lifecycle (symmetry with deploy.sh)
qc/                         integration tests
documents/                  what the system is (this pack)
docs/                       defect log + operator runbooks
```

## Develop

Preferred package manager: **Bun** (workspaces + lockfile).

```bash
bun install

# tests — note which command runs what
bun run test               # ALL Bun suites (node scripts/run-tests.mjs)
bun test                   # qc/ ONLY — bunfig pins [test] root = "./qc"
bun run test:observatory   # the SPA (Vitest)
bun run test:all           # both

# UI
bun run build:observatory  # required before the server or image serves the UI
bun run dev:observe        # API :8792 + Vite HMR :5190 (no Docker)

# run the observe plane from the checkout against a consumer
node packages/harness-observe-server/src/server.mjs --root <consumer>
```

Two traps worth knowing before you are surprised by them:

- **`bun test` does not run everything.** `bunfig.toml` pins the test root to `./qc`, and that setting
  **overrides paths passed on the command line** — `bun test <dir>` silently runs only `qc`. That is why
  `scripts/run-tests.mjs` runs each suite from inside its own directory. (`bun test --root` is not a
  supported flag; eight server test files had never executed because of this.)
- **`build:observatory` is a prerequisite, not a convenience.** A stale `dist/` looks exactly like a fix
  that did not work.

Dev ports: API `:8792`, Vite `:5190` (not Vite's default `5173` — that range belongs to another local
stack).

## Documentation map

| Need | Read |
|---|---|
| what it is, vocabulary, architecture | `documents/01.overview/` |
| how it behaves during a turn | `documents/02.runtime/` |
| on-disk layout, schema, API, hook contract | `documents/03.state-and-contracts/` |
| install, Docker, CLI, diagnosing a failure | `documents/04.operations/` |
| conventions, invariants, open issues | `documents/05.development/` |
| **the whole system as 20 pictures** | [`documents/06.diagrams/01.diagrams-mermaid.md`](documents/06.diagrams/01.diagrams-mermaid.md) |
| why a specific rule exists | `docs/04` (search the `F<n>` number) |
