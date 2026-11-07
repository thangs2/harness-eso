# @local/agentmemory-mcp-plugin

Local DSH Host plugin, source nằm trong repo **harness-eso**
(`tools/dsh-plugins/agentmemory`). Một plugin AgentMemory MCP cho **nhiều** repo. Mỗi workspace tự xác định
agentmemory server và credential của nó — cùng một profile DSH phục vụ được nhiều
memory store mà không cần plugin riêng cho từng repo.

| Mục | Giá trị |
|---|---|
| Loader row | `agentmemory-mcp-plugin` |
| Loại | Host plugin (có code), không dependency npm |
| Transport | stdio → `npx -y --offline @agentmemory/mcp`, mỗi agent một process |
| Tên tool | Giữ nguyên (`memory_smart_search`, `memory_save`, `memory_recall`, …) |
| Credential | `ctx.credentials` → secret trong `.cursor/mcp.json` của repo → biến môi trường → `~/.agentmemory/secret` (loopback) |
| Đo lường live | `agentmemory 0.9.32`, protocol `2025-06-18`, 8 tool (2026-11-07) |

## Vì sao cần bản này

Trên máy này **mỗi repo chạy một agentmemory container riêng**, cùng schema nhưng
port khác nhau:

| Repo | API | Viewer | Container |
|---|---|---|---|
| x79 | `:3111` | `:3113` | `agentmemory-agentmemory-1` |
| baplatform | `:3211` | `:3213` | `baplatform-agentmemory` |
| FinESO / fineso | `:3311` | `:3313` | `fineso-agentmemory` |
| harness-eso | `:3111` (dùng chung x79) | `:3113` | — |

Một row tĩnh trong `cordis.patch.yml` không thể phục vụ mô hình đó: **Loader
compose row một lần lúc boot**, trước khi có bất kỳ session hay working directory
nào, và `!!js` eval trong loader context — không có cwd của session. Nên quyết
định server nào phải nằm trong code, chạy mỗi lần agent được tạo.

`@deepseek-ai/dsh-mcp-client` cũng không dùng làm thư viện được: bản cài
`0.2.2-rc.1` export `{ Config, apply, createMcpToolDefinition, inject, name }` —
đủ cho một Loader row tĩnh, nhưng **không có factory client để mount
per-session**. Vì vậy `src/mcp-stdio-client.mjs` là MCP client tự viết, và **chỉ
import `node:*`**. Việc không import `@deepseek-ai/*` giữ plugin dependency-free:
một host plugin import Harness runtime có thể kéo bản sao thứ hai của singleton
vào profile (plugin Jira ghi failure mode này là ATF-OPS-001). Lưu ý: symbol
`TOOL_RUNTIME_SCHEDULER` mà các README sibling cite **không tồn tại** trong build
`0.2.2-rc.1` đang cài — nên đây là luật dependency-freedom, không phải một phép
đo lại.

## Ba sự thật đo được, và code sinh ra từ chúng

### 1. Server chết → shim âm thầm ghi vào một store dùng chung mọi repo

`@agentmemory/mcp` probe server **lười**, ở tool call đầu tiên. Probe fail thì nó
rơi vào "reduced LOCAL FALLBACK":

```
no server reachable at http://localhost:3211; running reduced LOCAL FALLBACK
with 7 of 54 tools. Start 'npx @agentmemory/agentmemory' (and point
AGENTMEMORY_URL at it) to unlock all 54 tools.
```

Store của fallback là `~/.agentmemory/standalone.json` — **một file cho mọi
repo**. Trên máy này file đó đang trộn memory của nhiều repo (đo 2026-11-07). Một
repo "quên" vào store của repo khác đúng là thứ plugin này sinh ra để chặn.

Cách chặn trong code, hai lớp độc lập:

1. **Probe trước khi mount.** Plugin tự gọi `GET <url>/agentmemory/livez` mỗi lần
   agent được tạo. Không trả lời đúng payload → **không đăng ký tool nào**, log lý
   do. Không có chế độ "mount anyway": với `FORCE_PROXY` thì handshake của shim
   tự fail trên URL chết (đo 2026-11-07: `-32603 fetch failed`), còn không có
   `FORCE_PROXY` thì shim rơi vào fallback dùng chung store.
2. **`AGENTMEMORY_FORCE_PROXY=1`** trong env của process con. Server có chết
   *sau* handshake thì call fail rõ ràng, không rơi vào fallback.

### 2. `tools/list` trông vẫn hợp lý khi server đã chết

Đo trên shim `0.9.32` (2026-11-07):

| Chế độ | `tools/list` trả về |
|---|---|
| Server sống (proxy) | 8 tool: `memory_recall`, `memory_save`, `memory_sessions`, `memory_smart_search`, `memory_consolidate`, `memory_diagnose`, `memory_lesson_save`, `memory_reflect` |
| Server chết (LOCAL FALLBACK) | 7 tool **khác bộ**: `memory_recall`, `memory_save`, `memory_sessions`, `memory_smart_search`, `memory_export`, `memory_audit`, `memory_governance_delete` — tất cả đều chạy, ghi vào `~/.agentmemory/standalone.json` |

Nghĩa là "thấy memory tool" **không** = "server của repo đang chạy". Vì vậy
`src/selfcheck.mjs` kiểm tra theo thứ tự: `livez` → handshake → tool list →
**một call đọc thật**, và plugin chặn fallback từ trước khi mount.

### 3. Mỗi process MCP là một lần trả giá khởi động

Đo trên máy này (2026-11-07, cùng một máy, 8 tool):

| Cách spawn | `initialize` + `tools/list` |
|---|---|
| `npx -y --offline @agentmemory/mcp` (cache ấm) | ~664 ms |
| `node ~/.npm/_npx/…/@agentmemory/agentmemory/dist/standalone.mjs` | ~46 ms |

Contract của Harness cho `agent/created` bắt buộc cài tool xong trước khi listener
return, nên handshake được await tại đó. `serverCommand`/`serverArgs` trong row
cho phép đổi sang entrypoint trực tiếp nếu cần nhanh hơn; mặc định giữ `npx` cho
khớp `.cursor/mcp.json`.

## Khai báo AgentMemory cho một repo

Thứ tự tìm, gặp cái đầu tiên là dừng — xét trên working directory của agent rồi
ngược lên tối đa 6 cấp cha (nên monorepo root phục vụ các package con). Trong mỗi
thư mục, xét theo thứ tự:

**1. `<repo>/.dsh/agentmemory.json`** — commit được, không chứa secret:

```json
{
  "url": "http://localhost:3211",
  "viewerUrl": "http://localhost:3213",
  "credential": "AGENTMEMORY_SECRET_BA_PLATFORM",
  "agentScope": "shared"
}
```

`credential` là **tên** key trong DSH credential store, **không phải** secret. Bỏ
trống thì với endpoint hosted (https) plugin tự suy ra
`AGENTMEMORY_SECRET_<HOST>`; với loopback thì không suy ra gì, vì shim tự đọc
`~/.agentmemory/secret`. Field nhận thêm: `serverUrl`/`endpoint`/`baseUrl` cho
endpoint, `secret` cho deployment local (đừng commit), `credentialMode` (chỉ nhận
`explicit`), `env` cho các biến `AGENTMEMORY_*` khác (`AGENTMEMORY_ENV_FILE`,
`AGENTMEMORY_DATA_DIR`, …).

**2. `<repo>/.cursor/mcp.json`** — những gì Cursor đang dùng trong repo đó. Cả bốn
repo trên đang dùng cách này, entry tên `agentmemory` hoặc `agentmemory-mcp`:

```json
{
  "mcpServers": {
    "agentmemory-mcp": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "--offline", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3311",
        "AGENTMEMORY_VIEWER_URL": "http://localhost:3313"
      }
    }
  }
}
```

**3. `<repo>/.agents/mcp_config.json`** — những gì Antigravity đang dùng (cùng
shape `mcpServers`, cùng biến `AGENTMEMORY_*`). Một plugin phục vụ cả hai tree.

`command`/`args` trong config của repo **bị bỏ qua có chủ đích**: plugin spawn
shim từ config của chính nó, để một repo không thể biến session agent thành một
process tuỳ ý.

**4. Không có config** → **không đăng ký gì**. Plugin không spawn process, không
làm chậm repo mà nó không được cấu hình. Sự bất đối xứng này chính là tính năng:
mở repo lạ mà vẫn thấy `memory_*` thì plugin đang đọc sai chỗ.

## Secret nằm ở đâu

Ưu tiên từ trên xuống:

**1. DSH credential store** — `$DSH_HOME/.credentials.yaml`, chỉ owner đọc được
(`chmod 600`), resolve mỗi agent qua `ctx.credentials.resolve(ref)`:

```yaml
version: 1
refs:
  AGENTMEMORY_SECRET_BA_PLATFORM: <dán-secret-thật-vào-đây>
```

**2. Secret mà config của repo đã mang sẵn** — `env.AGENTMEMORY_SECRET` trong
`.cursor/mcp.json`. Chỉ nên có ở file đã gitignore; plugin không copy nó đi đâu.

**3. Biến môi trường** — `AGENTMEMORY_SECRET` (hoặc `<tên-credential>`).

**4. Không có secret** — bình thường với loopback: shim tự đọc
`~/.agentmemory/secret`, và các server trên máy này trả lời không cần auth (đo
2026-11-07: `livez` 200, `memory_smart_search` thành công). Không có secret
**không** phải lỗi khởi động.

Không secret nào được copy vào thư mục plugin, nên thư mục này commit được.

## Cài đặt

Mở **Settings → Plugins** trong DSH → **install a bundle** → trỏ tới thư mục:

```
/Users/thangs2net/Workspaces/harness-eso/tools/dsh-plugins/agentmemory
```

Đây là **nguồn duy nhất** của plugin — repo `baplatform` không còn bản copy nào.

Nếu `plugin_manager` không được mount trong profile (profile `desktop` của máy này
không có nó — xem README của plugin Jira), sửa tay profile:

1. Thêm vào `~/.dsh/profiles/desktop/package.json`:

```json
"dependencies": {
  "@local/agentmemory-mcp-plugin": "link:/Users/thangs2net/Workspaces/harness-eso/tools/dsh-plugins/agentmemory"
},
"dsh": { "profile": { "bundles": [
  "...",
  "@local/agentmemory-mcp-plugin"
] } }
```

2. `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop install`
   (hoặc `pnpm install` trong `~/.dsh/profiles/desktop`).
3. Bundle tự chèn row `agentmemory-mcp-plugin` từ `cordis.patch.yml` của plugin.
   Muốn override config thì thêm row cùng id vào
   `~/.dsh/profiles/desktop/cordis.patch.yml` (như plugin Jira/Penpot đang làm).
4. Khởi động lại Harness sau khi sửa profile — Host plugin không HMR.

## Kiểm tra

**Không cần cài gì** — chạy đúng code mà plugin chạy lúc `agent/created`:

```bash
node tools/dsh-plugins/agentmemory/src/selfcheck.mjs /Users/thangs2net/Workspaces/harness-eso
# hoặc: node tools/dsh-plugins/agentmemory/src/selfcheck.mjs ../baplatform
```

Kết quả đúng (đo 2026-11-07):

```
url:        http://localhost:3211
livez:      ok (agentmemory)
server:     agentmemory 0.9.32
protocol:   2025-06-18
tools:      8 — memory_recall, memory_save, memory_sessions, memory_smart_search,
                memory_consolidate, memory_diagnose, memory_lesson_save, memory_reflect
search:     "agentmemory" → 336 bytes; …
PASS: livez, handshake, tool list and a read-only memory search all work.
```

Bốn repo đã cấu hình đều PASS; `/tmp` (không cấu hình) trả FAIL đúng như thiết kế.

**Test offline** — 46 test, không cần mạng, không cần server:

```bash
cd tools/dsh-plugins/agentmemory && node --test test/*.test.mjs
```

Bộ test phủ: resolution (4 dialect + precedence + parent walk), client (handshake,
JSON-RPC error, timeout, banner không phải JSON, thiếu binary), plugin lifecycle
(payload không phải agent, bootstrap agent đang sống, dispose giữa handshake,
plugin unload, event trùng, prefix), và invariant env (`FORCE_PROXY` không bị repo
ghi đè).

**Trong DSH:** mở repo đã cấu hình, hỏi agent `memory_smart_search` với một từ
khoá thật. Mở repo không có config, xác nhận **không có** tool AgentMemory nào.

**Đo end-to-end (2026-11-07)** bằng một profile headless nháp chỉ gồm
`dsh-base` + `dsh-headless` + plugin này:

| Workspace | Tool AgentMemory trong system prompt | Model gọi tool? |
|---|---|---|
| `.dsh/agentmemory.json` → `:3211` | đủ 8 tool | có, `memory_smart_search` trả về obsId thật |
| thư mục không có config | 0 tool | không (đúng thiết kế) |

**Chẩn đoán khi "không thấy tool":** headless host không in `logger.info` ra
terminal. Đặt `AGENTMEMORY_PLUGIN_DEBUG=1` để plugin ghi chẩn đoán ra stderr, và
`AGENTMEMORY_PLUGIN_DEBUG_FILE=/tmp/am.log` để ghi thêm ra file:

```bash
AGENTMEMORY_PLUGIN_DEBUG=1 AGENTMEMORY_PLUGIN_DEBUG_FILE=/tmp/am.log dsh ...
# [agentmemory-mcp-plugin] install agent/created session=session-…
# [agentmemory-mcp-plugin] start session=session-… cwd=/private/tmp/repo
# [agentmemory-mcp-plugin] target=http://localhost:3211 (/private/tmp/repo)
```

Dòng `target=none` nghĩa là repo **không** có config; dòng `cwd=null` nghĩa là
plugin không đọc được working directory — kiểm tra `inject` bên dưới.

Kiểm tra patch mà không cần cài (profile `desktop` từ chối `--dump-config`):

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --profile headless \
  --patch tools/dsh-plugins/agentmemory/cordis.patch.yml \
  --dump-config | grep -A 12 agentmemory-mcp-plugin
```

### Một lỗi inject của Cordis — lý do plugin khai báo `inject`

`ctx.workingDirectory` và `ctx.agents` là **service proxy**: đọc chúng khi không
khai báo trong `inject` sẽ ném `cannot get property "…" without inject`. Bọc
`try/catch` quanh chỗ đọc biến lỗi đó thành **im lặng**: 0 tool, 0 dòng log. Đo
thực tế trên DSH `0.2.2-rc.1` (2026-11-07): một bản chỉ có `inject: ['tools']`
resolve ra `cwd=null` và không đăng ký tool nào, trong khi cùng code với
`inject: ['tools', 'workingDirectory']` chạy đúng.

Vì vậy `src/plugin.mjs` khai báo `inject: ['tools', 'workingDirectory']` và đọc
service tuỳ chọn qua `ctx.get(name)` (`agents` cho bootstrap, `credentials` cho
secret). Test `plugin.test.mjs` khoá invariant này.

## Cấu hình

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `failOnStartupError` | `false` | `true` = log lỗi khởi động bằng `logger.error` thay vì `logger.info`. **Không** từ chối agent: `agent/created` throw thì `dsh-agent` từ chối đăng ký agent, tức là giết mọi session trong repo đó. |
| `timeoutMs` | `120000` | Trần thời gian mỗi lần gọi. Tool deadline đặt trên transport deadline 5 s để timeout hiện ra như một tool result có thể đọc được. |
| `probeTimeoutMs` | `2000` | Trần thời gian probe `livez` mỗi agent. |
| `serverCommand` / `serverArgs` | `npx` / `-y @agentmemory/mcp` | MCP server stdio sẽ spawn. Row của profile đặt `--offline` cho khớp cache trên máy này. |
| `insecureTls` | `false` | Truyền `NODE_TLS_REJECT_UNAUTHORIZED=0` cho **process con** (không hạ cấp cả Harness). Chỉ dùng khi có proxy nội bộ. |
| `toolPrefix` | `''` | Tiền tố tên tool. Mặc định rỗng để `memory_smart_search` khớp cách `AGENTS.md` gọi. |
| `default` | — | Target dự phòng toàn profile khi repo không có config. |

## Vòng đời agent — chỗ dễ sai nhất

`agent/created` và `agent/disposed` **không** truyền Agent làm tham số. `dsh-agent`
phát `ctx.serial(carrier, 'agent/created', { agent, source, …signal })` và
`{ agent }` khi dispose, còn `dispatch()` của Cordis cắt `this` và tên event khỏi
danh sách tham số trước khi gọi listener — nên listener nhận **payload**. Mọi
consumer của Harness đều destructure (`ctx.on('agent/created', ({ agent }) => …)`).

Đọc `agent.session` trên payload ra `undefined` → `workingDirectory.get(undefined)`
throw → bị `try/catch` nuốt → plugin đăng ký **0 tool, 0 dòng log**. Đây đúng là
lỗi mà bản Jira mắc phải (đã sửa cùng lúc, xem README Jira/Penpot). Test trong
`test/plugin.test.mjs` phát đúng payload thật, và có một test riêng khẳng định
một Agent trần bị từ chối.

Ba thứ khác ở vòng đời được xử lý thay vì bỏ qua:

| Tình huống | Hành vi |
|---|---|
| Agent đã sống trước khi plugin activate (HMR, bật qua plugin-manager) | `ctx.agents.list()` được seed, không chặn activation |
| Agent bị dispose trong lúc handshake còn đang chạy | process bị đóng ngay, không lọt vào Map |
| Plugin unload | mọi process con bị SIGTERM, tool bị dispose |
| `agent/created` trùng | `installFor` chặn bằng `installing`/`sessions`, không spawn process thứ hai |
| Call lỗi / server chết giữa session | trả value `{ text: 'AgentMemory MCP (label): …', isError: true }`; message của server vẫn tới model trong `text` (Harness không có cờ lỗi riêng ở tầng tool result) |

## Khác biệt so với `@local/jira-mcp-plugin`

| | Jira | AgentMemory |
|---|---|---|
| Transport | stdio, spawn mỗi agent | stdio, spawn mỗi agent (cùng cơ chế) |
| Đơn vị cấu hình | Atlassian site + email + token | base URL + secret tuỳ chọn |
| Credential | bắt buộc (thiếu token = không mount) | **không bắt buộc** với loopback (shim tự đọc secret) |
| Kiểm tra sống | handshake MCP | handshake **+ `livez`** (vì fallback vẫn có tool list) |
| Store khi server chết | không có fallback | fallback dùng chung mọi repo → phải chặn |
| Tên tool | giữ tên server | giữ tên server (`memory_*`, không prefix) |

## Giới hạn đã biết

- **Chi phí khởi động tính theo agent mới, không phải theo call.** Handshake được
  await trong `agent/created` (~0,7 s qua `npx` cache ấm, ~46 ms qua `node` trực
  tiếp — đo 2026-11-07). Connect nền sẽ khiến tool list có nguy cơ cài dở — tệ hơn.
- **Một process MCP cho mỗi agent đang sống**, không phải mỗi repo. Mười session
  đồng thời trong cùng một repo là mười process; mỗi cái nhẹ nhưng không chia sẻ.
- **Agent đổi working directory giữa session vẫn giữ target lúc khởi tạo.** Muốn
  đổi repo phải mở session mới.
- **`livez` chỉ chứng minh server sống**, không chứng minh index/session của repo
  đó đúng. `selfcheck.mjs` gọi thêm `memory_smart_search` (read-only) để kiểm tra
  đường đọc thật; nó không ghi gì.
- **Chỉ POSIX.** `isAbsoluteDir` đòi path bắt đầu bằng `/` và resolution từ chối
  root không phải POSIX, nên trên Windows plugin hiện **không** resolve được repo
  (silent no-op). Chưa hỗ trợ Windows.
- **Config hỏng là điểm dừng, không phải điểm bỏ qua.** `.dsh/agentmemory.json`
  (hoặc `.cursor/mcp.json` / `.agents/mcp_config.json`) tồn tại nhưng không parse
  được → plugin **không** đi tiếp lên thư mục cha (làm vậy sẽ mượn server của
  repo khác); nó log đường dẫn + lỗi và không mount tool. `selfcheck` FAIL cùng lý
  do.
- **`agentScope` chỉ có tác dụng với local-fallback** (và fallback bị tắt bởi
  `FORCE_PROXY`), nên trong proxy path bình thường field này là no-op — giữ lại
  để không phá config đã có.
- **Chỉ `tools`** — không hỗ trợ MCP `resources` hay prompt template.
- **8 tool của bản MCP 0.9.32**, không phải toàn bộ API của server (server có
  nhiều tool nội bộ hơn; shim chỉ expose 8).
- **Fallback của shim không bị xoá** — nó vẫn là hành vi của `@agentmemory/mcp`.
  Plugin chỉ không để nó xảy ra trong agent session: probe + `FORCE_PROXY`.
