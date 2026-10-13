---
description: harness-observe-server — REST, ingest, preflight, static Observatory bundle
layer: package
alwaysApply: false
globs: packages/harness-observe-server/**
---

# observe-server

- Entry: `src/server.mjs` · API surface: `observe-api.mjs`, routes `routes/*`
- DB: `db/migrations/*.sql` — migration mới = file số tiếp theo, không sửa migration đã ship
- Ingest: `ingest*.mjs`, `decision-ingest.mjs`, `eso-ingest.mjs`
- Preflight contract: `routes/v1-preflight.mjs` — đổi shape → cập nhật `qc/v1-preflight.test.mjs` và shard spec x79
- Static UI: build `harness-observatory` trước (`bun run build:observatory`)

Integration local:

```bash
node packages/harness-observe-server/src/server.mjs --root ../x79
```

Docker: `docker/observatory.sh` · port **8792**.
