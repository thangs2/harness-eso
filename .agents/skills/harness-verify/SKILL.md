---
name: harness-verify
description: Verifies harness-eso changes with bun tests, Observatory build, and Docker smoke against x79 consumer. Use after observe-server, hooks, docker, or E2E harness changes.
---

# harness-verify

## Host (bắt buộc trước PR / handoff)

```bash
cd /path/to/harness-eso
bun install
bun test
bun run build:observatory
bun run test:observatory
```

## Docker Observatory (E2E ingest)

```bash
export HARNESS_REPO_ROOT="../x79"   # consumer có harness.config.json
./docker/observatory.sh build
./docker/observatory.sh up "$HARNESS_REPO_ROOT"
./docker/observatory.sh health
./docker/observatory.sh smoke
```

Windows: `docker/observatory.ps1` (xem `docs/02.cursor-windows.md`).

UI: http://127.0.0.1:8792

## Integration server (không Docker)

```bash
node packages/harness-observe-server/src/server.mjs --root ../x79
```

## Khi fail

- Test qc cụ thể: `bun test qc/<file>.test.mjs`
- Migration/SQL: kiểm tra `packages/harness-observe-server/db/migrations/`
- Consumer chưa provision: `../harness-eso/harness init profile ../x79 --id x79` (từ operator machine)
