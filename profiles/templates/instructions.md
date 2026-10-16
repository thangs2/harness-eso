# Harness ESO — Instructions Index (Orientation)

> **Lưu ý:** File này là bảng chỉ mục định hướng, không thay thế luật tối cao (`AGENTS.md`).  
> Cursor / Antigravity Agent bắt buộc tuân thủ chuỗi thực thi (Execution Chain) bên dưới.

## Chuỗi Thực Thi Bắt Buộc (Forced Execution Chain)

```text
IDE Agent Session Start
  → Tự động nạp eager rules (alwaysApply: true, tối đa 6 rules)
  → core.law-gate.mdc  — Bước 1: Đọc AGENTS.md (Bắt buộc tối cao)
  → AGENTS.md          — Source of Truth tối cao của dự án
  → .harness/WORKFLOW_GUIDE.md — Sổ tay vận hành ESO & Token-Diet
  → Lazy rules & skills (chỉ nạp khi đụng globs, không được mâu thuẫn AGENTS.md)
```

## Bảng Chỉ Mục Dự Án (Catalog)

| Hạng mục | Đường dẫn | Chức năng |
|---|---|---|
| **Gatekeeper** | `.cursor/rules/core.law-gate.mdc` / `.agents/rules/core.law-gate.md` | Ép buộc tuân thủ quy trình chuẩn |
| **Supreme Law** | **`AGENTS.md`** (thư mục gốc) | Luật tối cao, phân cấp vai trò và công nghệ |
| **Workflow Guide** | **`.harness/WORKFLOW_GUIDE.md`** | Sổ tay vận hành ESO, Token-Diet, Preflight & Guards |
| **Decision Policy** | `.harness/decision-policy.json` | Cấu hình rào chắn, ngưỡng preflight và token diet |
| **Rules Directory** | `.cursor/rules/` & `.agents/rules/` | Bộ micro-rules chuẩn hóa |
| **MCP Config** | `.cursor/mcp.json` / `.agents/mcp_config.json` | Cấu hình MCP: codegraph, agentmemory, deepseek (docgraph chạy CLI) |
| **Observatory** | `http://127.0.0.1:8792` | Dashboard giám sát tiến trình và conformance checks |
