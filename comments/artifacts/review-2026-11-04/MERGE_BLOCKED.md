# MERGE BLOCKED — batch ESO-368…389

**Lý do:** QC độc lập 2026-11-04 kết luận **REJECT**: 4 PASS · 9 PARTIAL · 9 FAIL.
Xem `gemini-qc-2026-11-04.md` và `gemini-qc-scorecard.json`.

## 10 critical phải sửa

1. `scripts/eso-smoke-turn.mjs:14-22` — `rmSync(recursive)` trên `argv[2]`, không guard path.
2. `scripts/eso-smoke-turn.mjs:43-59` — tự tạo `hook.mjs` stub rồi gọi thẳng `recordTurnEvidence`.
3. `eso/graph/src/q4-permissions.mjs` + `q5-tenant.mjs` — SQL thiếu `project` trong `WHERE` ⇒ trả lời chéo project.
4. `eso/graph/src/completeness.mjs:74-84` — `class/method total=0` ⇒ coverage 1.0.
5. `eso/graph/src/q1-readset.mjs:169-182` — symbol không tồn tại ⇒ `ready + []`.
6. `eso/control-plane/src/routes.mjs:75-120` vs `config-store.mjs:38-50` — preview hash luôn `STALE_VERSION` khi save.
7. `eso/core/src/host-contract.mjs:105-140` — dispatch không `execute` vẫn báo `side_effect_applied:true`.
8. `eso/control-plane/src/routes.mjs` — không có route nào phục vụ S1 page.
9. `qc/scn-runner.test.mjs:351-381` — tự đánh dấu 24 SCN `executed`; 24/24 file test không tồn tại; ghi file tracked.
10. `qc/links.test.mjs:47` — bỏ qua link trong inline code, làm yếu X1.

## Điều kiện gỡ

- Sửa đủ 10 mục trên + các PARTIAL còn lại theo scorecard.
- Chạy lại `bun run test` xanh.
- QC lại độc lập, ghi verdict mới.
- Xóa file này **trong chính commit sửa** (test `qc/merge-block.test.mjs` sẽ xanh khi file vắng mặt).
