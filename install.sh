#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

die() { echo "install.sh: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "cài Docker Desktop / Engine"
docker compose version >/dev/null 2>&1 || die "cần docker compose v2"
docker info >/dev/null 2>&1 || die "bật Docker daemon"


if command -v bun >/dev/null 2>&1; then
    bun install
fi

HARNESS_REPO_ROOT="$ROOT" node "$ROOT/packages/harness-cli/src/cli.mjs" observatory build
# Consumers receive the built host pack, never the checkout — so it must exist before any
# `init profile`. Without this the provision fails loudly (`host pack not built at …`).
node "$ROOT/scripts/build-host-pack.mjs"
chmod +x "$ROOT/harness" "$ROOT/deploy.sh" "$ROOT/provision.sh" "$ROOT/console.sh" 2>/dev/null || true

echo ""
echo "Cài xong (monorepo @mu/harness-*)."
echo "  bun test"
echo "  bun run build:observatory"
echo "  Luật agent: AGENTS.md"
