# MERGE BLOCKED — batch ESO-368…389 (QC v2)

**Verdict QC v2 (2026-11-05): REJECT** — 5 PASS · 10 PARTIAL · 7 FAIL.
Chi tiết: `sdlc/09.wbs/00.jira/06.qc-v2-eso-368-389.md`.

## Critical phải sửa

1. Build bất khả thi: `tsc`/`ng` không được khai báo; `eso/ui` thiếu `angular.json`, `main.ts`, devDeps.
2. CI xanh giả: test import `dist/` bị gitignore; clean clone đỏ.
3. Auth fail-open: `/config`, `/config/preview`, `/s1` trả 200 khi không có token.
4. Stored XSS: `eso/control-plane/src/page/s1.mjs:71` chèn `turn_id` không escape.
5. Preview hash không kiểm; save cũ ghi đè version mới.
6. Q4/Q5 `project` optional ⇒ trả lời chéo project (`q4-permissions.mjs:30`, `q5-tenant.mjs:35`).
7. SCN runner ghi file tracked; 0/24 automation file tồn tại.
8. Merge block bị gỡ bởi chính người sửa, không có QC lại.
9. Bằng chứng không cite SHA; 14/22 verify log có trước commit sửa; audit ESO-371 chạy file không tồn tại.
10. Stack gate không có decision record cho NestJS/Angular.

## Điều kiện gỡ

- Build + typecheck + test xanh trên **clean clone**.
- 10 critical trên xanh.
- QC độc lập verdict mới.
- Xóa file này trong chính commit sửa.
