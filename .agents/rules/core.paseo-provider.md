---
description: Paseo → DSH provider pipeline — capability is profile-scoped; recon via per-cwd CLI, never claim an unmounted MCP
alwaysApply: true
---
# Paseo → DSH provider (capability là profile-scoped)

**Prerequisite:** `core.law-gate.mdc` (`AGENTS.md` Read this session).

#### Pipeline đo được (2026-11-08)

Paseo **không** đọc `AGENTS.md`, không mount MCP, không nạp rule/skill. Nó spawn một process rồi
bơm prompt qua stdio:

```text
Paseo daemon → plugin dsh-paseo (provider id `deepseek-harness-native`)
  spawn:  dsh --profile paseo        cwd = workspace của agent (PASEO_AGENT_CWD)
  stdio:  JSON-RPC  initialize {cwd, route}  →  prompt {content blocks}
  └─ DSH profile `paseo` = @deepseek-ai/dsh-base + dsh-paseo-bridge (+ bundle thêm nếu có)
       instructions (AGENTS.md · CLAUDE.md · AGENTS.local.md) · skills · tools · MCP · policy
```

Paseo chỉ mang 4 thứ qua ranh giới process: **cwd · route (provider/model/effort) · content blocks ·
session id**. Mọi thứ còn lại là của profile.

#### Luật

1. **Nhận diện session**: `PASEO_AGENT_ID` + `DSH_PROFILE=paseo` ⇒ session do Paseo spawn.
   Tool/MCP thuộc **profile**, không thuộc host — "DSH có X" là câu vô nghĩa nếu không nói profile nào.
2. **Không khai man recon.** Toolset không có `memory_*` / `codegraph_*` ⇒ nói rõ *"profile này không
   mount"*, không được viết "đã tra memory/docgraph" khi chưa gọi được.
3. **Recon thay thế, per-cwd** (đúng cho mọi worktree — đừng trỏ về checkout chính):

   ```bash
   codegraph explore "<symbol>" --path "$PWD"      # query · context · node · files
   docgraph --q "<terms>" --top 10 --repo "$PWD"
   ```

   `codegraph status` **không** nhận `--path`; thiếu `.codegraph/` ⇒ `codegraph init -i`.
   `docgraph --print-harness` cho biết nó đang thấy tree nào.
4. **Rules**: `.cursor/rules/` không được DSH scan. Always-on đến qua `AGENTS.local.md`
   (generated — `node scripts/build-dsh-rules.mjs`). Rule có `globs` đọc on-demand sau law gate.
   Sửa rule ⇒ sửa `.cursor/rules/*.mdc`, mirror `.agents/rules/*.md`, rồi regenerate.
5. **Skills**: catalog từ `.agents/skills/*/SKILL.md`; `.cursor/skills/` là mirror **phải giống byte**.
6. **Thêm MCP cho Paseo** = sửa profile `~/.dsh/profiles/paseo` (bundle + dependency), **không** sửa
   DSH core và **không** nhét vào `.cursor/mcp.json` rồi mong nó tự sang. Dùng
   `node scripts/setup-paseo-profile.mjs`.

#### Vì sao (defect)

2026-11-07 memory được đo trong profile **`desktop`** — profile đó có `@local/agentmemory-mcp-plugin`.
Kết quả được ghi vào bảng năng lực `AGENTS.md` thành *"DSH ✅ agentmemory"*, không kèm tên profile.
Session Paseo chạy **`paseo`** — chỉ `dsh-base` + bridge — nên không có một tool `memory_*` nào.
Bước 1 của "Thứ tự làm việc" (AgentMemory first) thành bất khả thi, và agent không kiểm tra sẽ khai
đã tra memory trong khi chưa hề gọi. Đây là cùng lỗi gốc với lần gộp bốn MCP vào một ô: **một ô
không tên profile thì cả hai chiều đều sai**.

#### Check

`env | grep PASEO_AGENT_ID` · `ls ~/.dsh/profiles/paseo/node_modules/@local` · thiếu tool ⇒ fallback
CLI và **nói ra**, không im lặng chuyển sang Grep rồi coi như đã recon.
