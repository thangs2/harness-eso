---
description: Conversation hygiene — token optimization, AgentMemory early search, docgraph/codegraph mandate, slice reading, shell limit
layer: core
alwaysApply: true
version: "1.1.0"
canonical: AGENTS.md
---

# Conversation Hygiene & Token Discipline

## 1. AgentMemory First (Truy vấn ngữ cảnh sớm)
- Luôn gọi `memory_smart_search` ngay đầu turn để thu thập context phiên trước, ticket ID, symbol, file path và từ khóa then chốt.
- Dùng từ khóa này làm đầu vào chính xác cho Docgraph và Codegraph, tránh query mò mẫm làm tăng token.

## 2. Docgraph First (No Markdown Bloat)
- Tra cứu concept, invariant, contract bằng `docgraph --q "<terms>"` (hoặc MCP `docgraph_query`) để lấy đúng đoạn 30–50 dòng.
- **Chỉ dùng `view_file` / `Read` khi Docgraph không có kết quả hoặc bắt buộc phải xem toàn văn file**.

## 3. Codegraph First (No Code Bloat)
- Dùng `codegraph_explore` (projectPath = harness-eso) khảo sát AST, call path và symbols trong 1 round-trip.
- **Chỉ dùng `Grep` + `Read` khi Codegraph thiếu thông tin hoặc cần quét regex cụ thể**.

## 4. Kỷ luật Range-Read (Slice Reading)
- Khi bắt buộc dùng `view_file` / `Read` cho file lớn (> 100 dòng), tuyệt đối không mở toàn bộ file vào context.
- Phải chỉ định rõ `StartLine` và `EndLine` (hoặc lệnh shell `sed -n 'X,Yp'`) để chỉ nạp đúng phân đoạn cần xử lý.

## 5. Giới hạn Shell Output
- Không chạy lệnh in ra output thô > 40 dòng vào context.
- Luôn pipe giới hạn khi kiểm tra: `git status -s`, `bun test 2>&1 | tail -n 25`, `head -n 30`, `grep -m 10`.
- Khi test pass chỉ cần tóm tắt kết quả (ví dụ `213 pass`).

## 6. Distillation & Memory Save (Đóng gói tri thức)
- Cuối mỗi turn xử lý logic quan trọng, gọi `memory_save` cô đọng quyết định, trạng thái và bài học.
- Giúp các turn kế tiếp kế thừa trực tiếp từ memory mà không cần đọc lại hàng loạt file cũ.
