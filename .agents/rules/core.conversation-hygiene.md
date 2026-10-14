---
description: Conversation hygiene — token optimization, docgraph/codegraph mandate, shell output limit
layer: core
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
---

# Conversation Hygiene & Token Discipline

## 1. Docgraph & Codegraph First (No file bloat)
- Tra cứu concept, invariant, contract bằng `docgraph --q "<terms>"` (hoặc MCP `docgraph_query`) để lấy đúng dòng/heading cần đọc. Không mở cả file hàng nghìn dòng vào context.
- Dùng `codegraph_explore` (projectPath = harness-eso) khảo sát AST, call path và symbols trong 1 round-trip. Không grep/read lặp nhiều file gây phình context.

## 2. Giới hạn Shell Output
- Không chạy lệnh in ra output thô > 40 dòng vào context.
- Luôn pipe giới hạn khi kiểm tra: `git status -s`, `bun test 2>&1 | tail -n 25`, `head -n 30`, `grep -m 10`.
- Khi test pass chỉ cần tóm tắt kết quả (ví dụ `213 pass`).

## 3. Quản lý Session
- Sau khi hoàn thành một phase lớn (như study, setup), nên bắt đầu session mới để reset context history.
