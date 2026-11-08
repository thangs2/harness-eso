---
name: paseo-recon
description: Recon inside a Paseo-launched DSH session (profile `paseo`) — check what the profile actually mounts, then use per-cwd codegraph/docgraph CLI. Use when PASEO_AGENT_ID is set, when a memory/codegraph tool is missing, or when adding an MCP server to the Paseo profile.
---

# paseo-recon

## Khi nào dùng

`env | grep PASEO_AGENT_ID` có giá trị ⇒ session này do Paseo spawn, DSH chạy profile `paseo`.
Luật nền: `core.paseo-provider.mdc`.

## 1. Biết mình đang có gì (10 giây)

```bash
env | grep -E '^(PASEO_AGENT_ID|DSH_PROFILE|PASEO_AGENT_CWD)='
ls ~/.dsh/profiles/paseo/node_modules/@local 2>/dev/null
```

Profile `paseo` = `@deepseek-ai/dsh-base` + `dsh-paseo-bridge` (+ bundle đã thêm). Không có gì trong
`node_modules/@local` nghĩa là **không có MCP**.

## 2. Code — codegraph CLI (không cần MCP)

```bash
codegraph status                      # index của repo hiện tại (KHÔNG có --path)
codegraph explore "<symbol>" --path "$PWD"
codegraph query "<name>" --path "$PWD" --limit 20
codegraph context "<task>" --path "$PWD"
codegraph node "<symbol>" --path "$PWD"
codegraph files --path "$PWD"
```

Thiếu index: `codegraph init -i` (tạo `.codegraph/`). Worktree mới **không** thừa hưởng index của
checkout chính — luôn truyền `--path "$PWD"`, đừng trỏ về `~/Workspaces/harness-eso` khi đang ở
worktree khác.

## 3. Doc — docgraph CLI (không có MCP)

```bash
docgraph --q "<terms>" --top 10 --repo "$PWD"
docgraph --print-harness             # đang thấy tree nào: cursor | ag | all
```

Output là `path<TAB>h1<TAB>headings<TAB>score`; `score = 0` là dòng fallback của ripgrep. Đọc đúng
đoạn 30–50 dòng, đừng mở cả file.

## 4. Memory — agentmemory (chỉ khi profile mount)

Có tool `memory_smart_search` / `memory_save` ⇒ dùng như `AGENTS.md` yêu cầu.
Không có ⇒ **nói rõ** "profile paseo chưa mount agentmemory", rồi recon bằng codegraph/docgraph.
Đừng viết "đã tra memory".

Bật (một lần, ngoài sandbox):

```bash
node scripts/setup-paseo-profile.mjs          # patch profile + pnpm install + warm npm cache
node scripts/setup-paseo-profile.mjs --check  # chỉ đọc
```

Sau đó reload plugin `dsh-paseo` trong Paseo (Settings → Plugins). Reload sẽ kết thúc turn đang chạy.

## 5. Thêm MCP server khác vào profile

Một row trong `~/.dsh/profiles/paseo/cordis.patch.yml`, dùng bridge có sẵn của DSH:

```yaml
- insert:
    - id: my-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: my-mcp          # tool hiện ra là mcp__my-mcp__<ToolName>
        transport: stdio
        command: /abs/path/to/server
        args: ["--flag"]
        env: {}
```

Bẫy: row được compose **một lần lúc boot**, trước khi có session/cwd. Muốn server phụ thuộc repo
(như agentmemory) thì phải là **host plugin** đọc `agent/created`, không phải row tĩnh — xem
`tools/dsh-plugins/agentmemory/src/plugin.mjs`.

## 6. Bẫy đã đo

| Bẫy | Hệ quả |
|---|---|
| `npx -y --offline @agentmemory/mcp` với cache lạnh | handshake fail → **0 tool**, không log rõ. Ấm cache: `npm i --prefix /tmp/x @agentmemory/mcp` |
| Thêm bundle nhưng quên `dependencies` `link:` | loader không resolve được package, agent mất tool |
| Sửa `.cursor/mcp.json` rồi mong Paseo thấy | Paseo không đọc file đó; profile mới là nơi mount |
| `codegraph status --path` | CLI báo `unknown option` — `status` lấy cwd |
