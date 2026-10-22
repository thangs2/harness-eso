# Docker / operator scripts

## Harness Console (monorepo product)

**`console.sh`** / **`console.ps1`** — wizard API + SPA on **Docker** (`compose.console.yml`, cổng **8791**).

| Command | Action |
|---------|--------|
| `build` | Host `build:console` + `docker compose build` |
| `up` / `start` | Stop local :8791, `compose up -d` |
| `down` / `restart` / `status` / `health` / `logs` | Compose lifecycle |

Env: `HARNESS_AGENT_ROOT` · `HARNESS_CONSOLE_PORT` (8791) · `HARNESS_OBSERVE_HEALTH_BASE` (mặc định `http://host.docker.internal:8792` trong container) · `HARNESS_PRODUCT_STATE_HOST` (mặc định `~/.harness`)

```bash
export HARNESS_AGENT_ROOT=~/Workspaces
./docker/console.sh build && ./docker/console.sh up
```

---

## Harness Observatory — Docker

One container: **Observatory API + UI** on port **8792**. Host needs **Docker** (+ Compose v2) only.

Workspace config: `~/.harness/workspace.json` (hoặc `$HARNESS_PRODUCT_STATE_DIR`) — xem [docs/00.getting-started.md](../docs/00.getting-started.md).

## Luồng operator

Chỉ cần duy nhất bộ lệnh `./harness` (hoặc `docker/observatory.sh` / `console.sh`):

1. **Cài đặt & Build:** `./install.sh`
2. **Khởi động Observatory:** `./harness up` (port 8792)
3. **Khởi động Console (nếu cần wizard):** `./harness console` (port 8791, chạy ở terminal riêng)
4. **Kiểm tra sức khoẻ & Sanity:** `./docker/observatory.sh smoke` hoặc `curl http://127.0.0.1:8792/api/tenant`

## Quick start

```bash
cd harness-eso
./install.sh
./harness up                    # bước 1
./harness console               # bước 2 (terminal riêng)
./harness health
```

Equivalent via **`docker/observatory.sh`** (same CLI underneath):

```bash
export HARNESS_REPO_ROOT=~/Workspaces/x79
./docker/observatory.sh build
./docker/observatory.sh up
./docker/observatory.sh health
./docker/observatory.sh smoke
```

Or `bun run harnessctl observatory up --project x79` (forwards to `packages/harness-cli/src/observatory-cmd.mjs`).

### Commands (`observatory.sh` / `observatory.ps1`)

| Command | Action |
|---------|--------|
| `build` | Host `bun run build:observatory` (if bun) + `docker compose build` |
| `up` / `start [consumer]` | Compose up; optional path with `harness.config.json` sets `HARNESS_REPO_ROOT` |
| `down` | Compose down |
| `restart [consumer]` | down + up |
| `status` | Compose ps |
| `health` | `GET /health` |
| `logs` | Compose logs |
| `smoke` | Health + ingest + requests sanity |

Flags: `--no-build` · `--foreground` / `-f`

Env: `HARNESS_REPO_ROOT` · `HARNESS_OBSERVE_PORT` (default `8792`) · `HARNESS_CURSOR_HOME` (default `~/.cursor`)

### Storage (SQLite)

`harness.db` lives **outside every consumer repo**, in `HARNESS_DATA_ROOT/<projectId>/harness.db`.
Same layout for both planes, only the root differs — so a project has exactly one DB location
per plane instead of a copy inside each consumer working tree.

| Plane | `HARNESS_DATA_ROOT` | DB |
|-------|--------------------|-----|
| Docker Observatory | `/data/observe` (compose volume `observe-data`) | `/data/observe/<projectId>/harness.db` |
| Local dev (`scripts/dev-observe.sh`) | `~/.harness/observe` (default) | `~/.harness/observe/<projectId>/harness.db` |

`<projectId>` = `project.id` in the consumer `harness.config.json`. Override the root with
`HARNESS_DATA_ROOT=…`, or the file outright with `HARNESS_SQLITE_PATH=…`
(`packages/harness-observe-server/src/observe-config.mjs`). Unset both and the server falls back
to the consumer-local `<repo>/.harness/harness.db` (the bare `server.mjs --root …` path).

Mounts for the Docker plane:

| Mount | Mode | Purpose |
|-------|------|---------|
| `HARNESS_REPO_ROOT` → `/data/repo` | **read-only** | `harness.config.json`, hooks (`route-trace.jsonl`), policy |
| Compose volume `observe-data` → `/data/observe` | rw | `harness.db` at `/data/observe/<projectId>/harness.db` |
| `HARNESS_PRODUCT_STATE_HOST` (default `~/.harness`) → `/data/product-state` | rw | `workspace.json`, `tenants.json`, **MCP usage ledger** |
| `~/.cursor` → `/host-cursor` | ro | Agent transcript JSONL (REQUEST spine) |
| `~/.dsh` → `/host-dsh` | ro | DSH sessions (`session.v4.jsonl.zstd`); filter theo workspace slug |
| `~/.harness` → `/data/product-state` | rw | product state, gồm `eso-blockers.jsonl` (gate trail) |

### MCP model usage ledger

A Cursor turn's cost is mostly spent inside MCP model calls, so the DeepSeek MCP server writes one
JSONL line per model call and the observe plane reads it to attribute that spend to a request.

Both sides resolve it through **product state**, as `<product-state>/deepseek-usage.jsonl`:

| Where | Resolves to |
|-------|-------------|
| Host (the MCP server runs here, under Cursor) | `~/.harness/deepseek-usage.jsonl` |
| Docker observe plane | `/data/product-state/deepseek-usage.jsonl` → host `~/.harness/deepseek-usage.jsonl` |

No extra mount is needed: the product-state bind mount above already carries it. This is deliberate —
an earlier version put the ledger under `HARNESS_DATA_ROOT`, which is the *same directory* on the
host (so local development looked correct) but a **named volume** in Docker, a container-only
filesystem the host MCP server cannot see. Nothing was ever attributed in a container.

Override both sides with `DEEPSEEK_USAGE_LEDGER=/abs/path` if you want the ledger on a shared volume
or need to point a second deployment at one file. The MCP server is installed standalone
(`~/.gemini/antigravity/deepseek_direct.js` via `x79/installation/deepseek/install.sh`) and cannot
import workspace packages, so it mirrors this rule rather than sharing it — keep the two in step.

Rows the observer cannot attribute are kept with a null `request_id` rather than dropped, so spend
that cannot be placed is still visible as spend.

The consumer is mounted read-only because a bind-mounted SQLite DB written from a macOS host
into a Linux container is what corrupted it. First `up` starts an empty DB and re-ingests from
transcripts/hooks. To migrate a recovered DB once:

```bash
docker compose -f compose.harness.yml run --rm -v observe-data:/data/observe observe-server \
  sh -c 'mkdir -p /data/observe/x79 && cp /path/on/host/harness.db /data/observe/x79/harness.db'
```

Do not run `scripts/dev-observe.sh` on the same port while Docker Observatory is up. Their DBs
are now separate, but the port is not.

## Host config for a consumer

A **consumer** is a repo that *uses* the harness. It must live outside `harness-eso` —
provisioning the product repo would write host hooks into the repo that ships them.
`buildProvisionPlan` refuses an empty `agentRepo.root` and any path inside `harness-eso`.

The console provisions the consumer from a **built host pack**, so it no longer needs to know where
the host checkout lives — no path back to `harness-eso` is ever written into a consumer.

| Env | Value | Purpose |
|-----|-------|---------|
| `HARNESS_ESO_ROOT` | `/app` (in-container) | product code inside this image; never written to a consumer |
| `HARNESS_PRODUCT_STATE_DIR` | `/data/product-state` | `workspace.json`, `projects/`, `tenants.json` |
| `HARNESS_PRODUCT_STATE_HOST` | host path, default `~/.harness` | what `/data/product-state` is bind-mounted from |
| `HARNESS_AGENT_ROOT_HOST` | host agent workspace, e.g. `~/Workspaces` | offered as `agentRootDefault` in the wizard |

### Reload host config

```bash
curl -X POST http://127.0.0.1:8791/api/projects/x79/reload
# also rewrite the tenant anchor (harness.config.json):
curl -X POST http://127.0.0.1:8791/api/projects/x79/reload -d '{"tenant":true}'
# CLI equivalents:
./harness init profile ~/Workspaces/x79 --id x79          # host pack (config skipped if present)
./harness init profile ~/Workspaces/x79 --id x79 --force   # + rewrite harness.config.json
```

Rewrites hook bins, `hooks.json` (merged and **de-duplicated**), `sidecar.env`, and
`.harness/host-bootstrap.json` with a fresh `appliedAt`. Re-running is idempotent: each
hook command appears exactly once per event. Cursor still needs a window reload before new
`hooks.json` entries take effect.

`harness.config.json` is `create-if-missing`, so a **stale one can never be repaired** by a
plain run — a schema change or a wrong `tenancy.registry` would be permanent, and hand-editing
tenant JSON is forbidden by spec §24. `--force` / `{"tenant":true}` is the supported repair:
it rewrites the anchor from the plan. `decision-policy.json` is still only **merged** — the
plan's keys are re-applied (wizard choices win) while operator keys the plan does not define
survive, which a forced rewrite would drop.

Open http://127.0.0.1:8792

## Multiple consumer projects

One container = one consumer mount + one port. Use different ports (`COMPOSE_PROJECT_NAME` = `harness-observe-<port>`).

```bash
# Primary ESO consumer for harness-eso dev (see AGENTS.md)
HARNESS_OBSERVE_PORT=8792 ./docker/observatory.sh up ~/Workspaces/x79
# Another repo on a different port (optional; same pattern)
HARNESS_OBSERVE_PORT=8793 ./docker/observatory.sh up ~/Workspaces/other-consumer
```

## Files (this folder)

| File | Purpose |
|------|---------|
| `observatory.Dockerfile` | Image build (Bun + SPA + `@mu/harness-observe-server`) |
| `console.sh` / `console.ps1` | Console server + SPA build/dev |
| `observatory.sh` / `observatory.ps1` | Operator entrypoint → `node packages/harness-cli/src/cli.mjs observatory …` |
| `compose.harness.yml` (repo root) | Compose service `observe-server` (image Observatory) |

Implementation: **`packages/harness-cli/src/observatory-cmd.mjs`**. Scripts only forward args.

## Cursor transcript ingest

`compose.harness.yml` mounts `${HARNESS_CURSOR_HOME:-$HOME/.cursor}` → `/host-cursor` (read-only). Transcripts: `/host-cursor/projects/<slug>/agent-transcripts` (`<slug>` = consumer path with `/` → `-`).

## Rebuild after code changes

```bash
./docker/observatory.sh build
./docker/observatory.sh restart
```

## Dev without Docker

`bun run dev:observe` (API + Vite HMR, no Docker) or `bun run dev:observatory` + `bun run observe:server -- --root <consumer>` — root `README.md`.
