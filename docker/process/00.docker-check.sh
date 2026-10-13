#!/usr/bin/env bash
# [00] Prerequisites — Docker daemon + bun (harness-eso host build)
set -euo pipefail
PROCESS_DIR="$(cd "$(dirname "$0")" && pwd)"
ESO_ROOT="$(cd "$PROCESS_DIR/../.." && pwd)"

die() { echo "[00.docker-check] $*" >&2; exit 1; }

echo "==> [00] harness-eso root: $ESO_ROOT"
[[ -f "$ESO_ROOT/package.json" ]] || die "not harness-eso root (missing package.json)"

if ! docker info >/dev/null 2>&1; then
    die "Docker daemon not running — start Docker Desktop, wait until Ready, then re-run ./01.observatory-up.sh"
fi
echo "==> [00] Docker: OK"

if ! command -v bun >/dev/null 2>&1; then
    die "bun not found — install bun (host build step in observatory.sh build)"
fi
echo "==> [00] bun: OK"

if [[ ! -d "$ESO_ROOT/node_modules" ]]; then
    die "run once: cd \"$ESO_ROOT\" && bun install"
fi
echo "==> [00] node_modules: OK"
echo "[00] OK — next: ./01.observatory-up.sh"
