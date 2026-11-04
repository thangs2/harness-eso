#!/usr/bin/env bash
# Wrapper cho scripts/jira-pack.mjs — Task 1.5 (ESO-38)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/jira-pack.mjs" "$@"
