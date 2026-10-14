---
description: ESO spec shards on x79 — read before contract/API changes
layer: core
alwaysApply: false
version: "1.0.0"
canonical: ../x79/document/harness/02.harness-eso/00.index.md
globs: docs/**,packages/harness-observe-server/**,packages/harness-observatory/**
---

# Harness ESO — specification (consumer docs)

**SoT:** `../x79/document/harness/02.harness-eso/` (không copy vào harness-eso).

## Read order

1. `00.index.md`
2. Task shard: `02` pipeline · `07` policy/Jev · `10` kernel · `11` storage · `12` deploy · `13` WBS · `16` Observatory
3. Runbook: `17.operational-runbook-eso.md`
4. Skill: `harness-eso-implement`

`99.appendix-legacy-pointers.md` — không phải product law. `01.baseline` / `researches/` — tham chiếu.

## Implement vs spec

| Việc | Repo |
|------|------|
| Sửa `@mu/harness-*` | **harness-eso** (workspace này) |
| Sửa shard thiết kế | **x79** `document/harness/**` + rule `core.harness-eso` ở window x79 |

Không áp `document/mu/be/00.law/` (CQRS, MongoDB) lên packages harness — chỉ ESO shards + `AGENTS.md`.

## Sau đổi spec ảnh hưởng runtime

```bash
bun test
bun run build:observatory
./docker/observatory.sh smoke   # HARNESS_REPO_ROOT=../x79
```
