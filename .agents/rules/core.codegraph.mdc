---
description: CodeGraph on harness-eso packages — codegraph_explore before edits
layer: core
alwaysApply: false
version: "1.0.0"
globs: packages/**,qc/**
---

# CodeGraph (harness-eso)

Tool: **`codegraph_explore`** (namespace `user-codegraph`). `projectPath` = root **harness-eso** (hoặc thư mục package đang sửa).

## Rules of thumb

- Một lần explore thường đủ cho câu hỏi flow/symbol — output đã có source có line; **không** mở lại file đã nằm trong kết quả.
- Tin kết quả AST; không grep để “xác minh” symbol đã thấy trong explore.
- Index lag ~500ms sau edit — không query lặp cùng turn.
- Không có `.codegraph/` → Read/Grep; gợi ý user `codegraph init -i` tại repo root.

## Consumer-only code

Ingest, transcript paths, `.harness/decision-policy.json` trên **x79** → `projectPath` = `../x79` khi explore consumer-only.
