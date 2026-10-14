---
description: Observatory & Console SPAs — React, Vite, Tailwind
layer: package
alwaysApply: false
globs: packages/harness-observatory/**,packages/harness-console/**
---

# Observatory / Console UI

- **Observatory** `:8792` — `harness-observatory`: router `src/app/router.tsx`, API `src/shared/api/`
- **Console** `:8791` — wizard provision; không nhầm với Observatory monitor
- Test: `bun run test:observatory` (Vitest); component tests cạnh feature (`*.test.tsx`)
- API types: giữ khớp `harness-observe-server` responses; đổi contract → server + `shared/api/types.ts` + qc nếu có

Build chain: `bun run build:observatory` → artifact observe-server phục vụ static.
