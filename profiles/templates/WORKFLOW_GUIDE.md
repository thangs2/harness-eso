# Harness ESO — Consumer Workflow Guide (V3.0)

> **Document Code:** `HARNESS-ESO-CONSUMER-GUIDE-V3`
> **Applies to:** mọi repo đã được provision (`harness.config.json` + `.harness/`).
> **Đọc file này khi:** bạn vừa provision xong, một lệnh bị chặn mà không rõ vì sao, hoặc muốn biết
> ESO đang ghi gì về phiên làm việc của mình.
>
> Hướng dẫn này **generic**: nó mô tả harness-eso, không mô tả workflow riêng của một dự án nào. Quy
> trình nội bộ của bạn (Jira, SDLC, wave…) thuộc tài liệu của chính repo bạn.
>
> **File này là reference, không phải checklist.** Nếu bạn vừa provision xong và cần biết *làm gì, theo
> thứ tự nào*, đọc [`ONBOARDING.md`](./ONBOARDING.md) cùng thư mục rồi chạy `./.harness/diagnostics.sh`.
> Quay lại đây khi cần hiểu **vì sao** một cơ chế hoạt động như vậy.

---

## 1. Cái gì đã được cài vào repo này

| Đường dẫn | Là gì | Ai ghi |
|---|---|---|
| `harness.config.json` | danh tính repo (project id), ingest, server, integrations | operator |
| `.harness/decision-policy.json` | luật: `paths` (locked/ask/gated), `eso`, `checks` | operator |
| `.harness/host-pack/` | bundle hook `harness-hook.mjs` (1 file, 0 import ngoài `node:*`) + `route-hook.py` | `harnessctl` |
| `.harness/host-install-state.json` | tree nào đã nối, entry nào của ESO | `harnessctl` |
| `.harness/host-bootstrap.json` | profile đã áp, phiên bản pack, kết quả verify | `harnessctl` |
| `.cursor/hooks.json`, `.agents/hooks.json`, `.claude/settings.json` | nơi host gọi hook; **hook của bạn được giữ nguyên** | host + `harnessctl` |
| `.<tree>/session/` | bằng chứng của phiên: `.eso-preflight.json`, `route-trace.jsonl`, gap, hint | agent (được phép) |
| `~/.harness/` | **product state**: project registry, tenant, attestation, `eso-blockers.jsonl` | chỉ ESO |

Nguyên tắc: **record mà gate tin nằm ở `~/.harness/`**, agent không ghi được. Thứ agent ghi được
(`.<tree>/session/`) chỉ là bằng chứng để đọc lại, không bao giờ là căn cứ để cho qua.

---

## 2. Nó hoạt động thế nào

Hai plane, không có kênh ngầm nào khác:

```text
CONTROL PLANE (trong phiên)                     OBSERVE PLANE (sau phiên)
  prompt ─► preflight ─► verdict                  transcript + session artifacts
  tool   ─► gate     ─► allow/deny/ask              ─► ingest ─► SQLite ─► Observatory :8792
  cuối turn ─► evidence
```

Ba hình thức ESO có mặt — **không thay nhau**:

| Hình thức | Host | Cưỡng chế bằng |
|---|---|---|
| Host pack (hook) | Cursor, Antigravity, Claude Code | `permissionDecision: deny` trên hook |
| DSH plugin | DeepSeek Harness | `{kind:'deny'}` trên `tools/pre-execute`, `{kind:'reject'}` trên `agent/pre-step` |
| CLI | terminal / CI | exit code + report |

### Một lượt chạy, theo thứ tự

```text
1. Bạn gửi prompt
   └─ host gọi hook preflight (hoặc plugin agent/pre-step)
      ├─ thu bằng chứng: law / code / memory theo provider chain của policy
      ├─ chấm sufficiency → level, score, gaps
      └─ dựng TurnVerdict: allowPromptSubmit · allowProtectedWrite · hardBlockers

2. Agent gọi tool
   └─ host gọi guard (hoặc plugin tools/pre-execute)
      ├─ path tier: locked → deny · ask/gated → cần consent · không tier → cho qua
      └─ shell: phân tích lệnh để tìm đích ghi, cùng bộ luật với write

3. Sau tool
   └─ gap-tracker + post-tool-hint ghi vào session (telemetry, không chặn)

4. Kết thúc turn
   └─ ghi chi phí context (host pack), cập nhật route trace
```

Không có bước nào "chấm điểm rồi tự quyết". Score chỉ mô tả; **quyết định chặn dựa trên tier của
path hoặc finding có tên**.

---

## 3. Pipeline vận hành — 7 bước (Cursor / Antigravity / Claude)

Đây là pipeline **đang chạy** trên host IDE. Mỗi bước có một chỗ implement và một hook tương ứng; nếu
một hook không fire, bước đó không có bằng chứng.

| # | Bước | Làm gì | Hook / lệnh | Code |
|---|---|---|---|---|
| 1 | Cognitive preflight | contract domain + pinned invariants + fingerprint; quyết định `HOT` (continuation cùng stem, fingerprint khớp) / `WARM` (sufficient → JIT-pin ≤30 token) / `STALE` / `COLD` | `beforeSubmitPrompt` · `PreInvocation` | `preflight-hook.mjs`, `preflight-projection.mjs`, `context-contract.mjs` |
| 2 | Decision facade | route bucket bằng L0 (0 ms) hoặc JEV; chọn surface/skill pack | trong preflight | `orchestrate-turn.mjs`, `harness-decision` |
| 3 | Recon | thu bằng chứng theo `sources`: law = **docgraph**, code = **codegraph**, memory = **agentmemory** (opt-in) | trong preflight | `adapter-registry.mjs`, `collect.mjs` |
| 4 | Sufficiency + gate | chấm level/score/gaps → `TurnVerdict`; **cổng quyết định là tier của path và hard blocker**, score chỉ mô tả | preflight | `gate.mjs`, `attest.mjs`, `hard-blockers.mjs` |
| 5 | Brain allocation | guard buộc chọn tier `pro` / `flash` / direct trước khi gọi model | `preToolUse` (brain) | `guard-brain-hook.mjs`, `reasoner.mjs` |
| 6 | Exec + verify | guard shell/write; check deterministic trước khi merge | `beforeShellExecution`, `check *` | `guard-shell-hook.mjs`, `contract-diff`, `tenant-check`, `migration-check` |
| 7 | Distill + handoff | gap closure, hint sau tool, chi phí trước compact, lưu bài học | `postToolUse`, `preCompact` | `gap-tracker`, `post-tool-hint`, `pre-compact` |

### 3.1 Vì sao vẫn cần docgraph + codegraph + agentmemory

Bước 3 không có nguồn thay thế trên host IDE: không có "native provider" nào ở Cursor/Antigravity, nên
chain resolve ra external. Kiểm tra bằng:

```bash
harnessctl capability probe .        # law: docgraph-cli · code: codegraph-cli · memory: agentmemory-mcp | none
```

Memory là **opt-in**: consumer chưa khai thì resolve `none`, không tự gọi.

### 3.2 Điều đã đổi, và điều không đổi

- **Không đổi**: 7 bước, thứ tự, hook nào làm bước nào.
- **Đã đổi ở bước 4**: quyết định không còn dựa trên ngưỡng score (đo được: 2/2 tín hiệu quality gate là
  false positive). Cổng bây giờ là **tier path** (`locked`/`ask`/`gated` + consent) và **hard blocker**
  (`contract`/`tenant`/`migration`). Score vẫn được tính để mô tả, không dùng để cho qua.
- **Đã đổi ở bước 3**: nguồn bằng chứng chọn bằng dữ liệu (`sources`, recipe), không hard-code ba công cụ.

### 3.3 Host khác thì khác ở đâu

| Host | Evidence spine (bước 1–4) | Gate (bước 4 write + 6) | Brain guard (5) | Trail |
|---|---|---|---|---|
| Cursor / Antigravity / Claude | có, qua hook + 3 MCP | có | có | session artifacts |
| DSH (plugin `@mu/harness-eso-dsh`) | **chưa có** — plugin không chạy preflight | có | chưa | `~/.harness/eso-blockers.jsonl`, tab **Gate** |

DSH là host **bổ sung**, không thay thế host IDE: nó thêm đường cưỡng chế in-process + audit trail, còn
bằng chứng (law/recon/brain) vẫn chỉ có khi chạy qua host pack.

## 4. Cái gì có thể bị chặn, và vì sao

### 3.1 Ba tier của path (`.harness/decision-policy.json` → `paths`)

| Tier | Hành vi | Dùng khi |
|---|---|---|
| `locked` | **deny**, không có đường vòng | luật, hợp đồng, secret, thứ không bao giờ được sửa bởi agent |
| `ask` | cần phê duyệt (hoặc deny, xem 3.3) | vùng nhạy cảm nhưng đôi khi cần sửa |
| `gated` | như `ask`, nhưng consent có hạn theo thời gian | vùng cần audit thường xuyên |

Mặc định sản phẩm có sẵn một bộ tier; khai `paths` trong policy **thay thế** bộ mặc định, không nối
thêm. Khai `[]` nghĩa là "không bảo vệ gì" — đó là quyết định, không phải thiếu sót.

### 3.2 Hard blocker — thứ duy nhất được dừng cả bước

Ba check deterministic, chạy trên input do bạn khai (`eso.checks`):

| Check | Bắt gì | Ví dụ |
|---|---|---|
| `contract` | breaking change trên OpenAPI subset | xoá path, xoá field response, đổi type |
| `tenant` | statement chạm bảng tenant mà không có tenant filter | `select * from orders` |
| `migration` | DDL không backward-compatible | `drop table`, `rename`, `set not null` |

Blocker **không phải điểm số**: nó có `source`, `kind`, `ref` (file/path/table), `detail`. Nếu một
finding là ngoại lệ đã review, ghi quyết định **tại nguồn**:

```sql
select * from orders /* tenant:global */;
alter table orders drop column legacy /* breaking:approved */;
```

Marker biến statement thành "đã quyết định", không phải "đã bỏ qua". Đừng nới ngưỡng — không có ngưỡng.

### 3.3 `ask` khác nhau giữa host pack và DSH plugin

- **Host pack**: trả `ask`/`deny` cho host; host nào có UI phê duyệt thì hiện.
- **DSH plugin**: mặc định **deny** cho tier `ask`/`gated` không consent — vì trên DSH, một quyết định
  `ask` **không chặn** (đã đo: write lọt). Muốn uỷ quyền cho UI của host:
  `"askMode": "host"` trong config của row.

Consent của ESO nằm ở product state (`~/.harness`), không phải ở UI host. Hết hạn thì phải xin lại.

---

## 5. Bằng chứng và dấu vết

### 4.1 Session (agent ghi được — chỉ để đọc lại)

| File | Nội dung |
|---|---|
| `.<tree>/session/.eso-preflight.json` | verdict của lượt gần nhất: level, score, at, gaps |
| `.<tree>/session/route-trace.jsonl` | từng quyết định route/preflight theo thời gian |
| `.<tree>/session/.eso-gap-closure.json` | gap nào đã đóng trong phiên |
| `.<tree>/session/.eso-bundle-stamp.json` | dấu của bundle đã cài |

### 4.2 Product state (gate tin)

`~/.harness/eso-blockers.jsonl` — append-only, mỗi dòng là một quyết định chặn:

```json
{"at":"2026-10-22T05:18:29Z","kind":"tool-deny","host":"dsh","projectId":"my-repo",
 "event":"tools/pre-execute","tool":"write",
 "blockers":[{"source":"policy","kind":"gate-decision","ref":"secrets/x.txt",
              "detail":"locked by the consumer's path policy"}]}
```

`kind` là `hard-blocker` (chặn cả bước) hoặc `tool-deny`/`tool-ask` (chặn một tool). Đọc bằng:

```bash
tail -n 20 ~/.harness/eso-blockers.jsonl
```

---

## 6. Lệnh thường dùng

Tất cả chạy từ checkout harness-eso (hoặc `harnessctl` nếu đã cài toàn cục):

| Việc | Lệnh |
|---|---|
| **Biết mình đang thiếu gì** | `./.harness/diagnostics.sh` (theo layer; `--json` cho CI) |
| Provision consumer | `harnessctl init profile <path> --host-mode dual-ide` |
| Thêm một IDE vào consumer đã có | `harnessctl host-pack add-ide <path> --profile claude-superset` |
| Gỡ một IDE, giữ hook của bạn | `harnessctl host-pack remove-ide <path> --ide claude` |
| Kiểm tra máy có chạy đúng không | `harnessctl verify consumer <path> --strict` |
| Kiểm tra host đã nối đúng chưa | `harnessctl verify host <path>` (H0–H5) |
| Xem provider nào đang phục vụ | `harnessctl capability probe <path> --recipe dsh-native` |
| Kiểm contract trước/sau | `harnessctl check contract before.json after.json` |
| Kiểm tenant | `harnessctl check tenant <file> --tables orders` |
| Kiểm migration | `harnessctl check migration <file>` |
| Kiểm profile DSH có nguy cơ hỏng | `harnessctl doctor dsh --profile desktop` |
| Bật observability | `harnessctl observatory up` (một URL: `:8792`) |

Conformance `H0`–`H5` là **bằng chứng**, không phải điểm số:

| Tier | Chứng minh |
|---|---|
| H0 | hook config gọi đúng `harness-hook.mjs` |
| H1 | pack có mặt và có ít nhất một guard được nối |
| H2 | preflight đã tạo verdict (có `level` + `at`) |
| H3 | route trace có ít nhất một event |
| H4 | có native provider (chỉ bắt buộc khi `--require-native`) |
| H5 | gate nằm ngoài vùng mà optimizer được sửa |

H4/H5 mặc định `skip` khi không áp dụng; `skip` không phải `pass`.

---

## 7. Việc cần làm theo nhịp

**Trước khi merge thay đổi có schema/API:**

```bash
harnessctl check contract api/before.json api/after.json
harnessctl check migration db/migrations/*.sql
harnessctl check tenant db/queries/*.sql --tables orders
```

**Sau khi sửa policy hoặc thêm check:**

```bash
harnessctl verify consumer . --strict     # policy còn hợp lệ và gate còn chạy
harnessctl capability probe .             # provider resolution đúng như bạn nghĩ
```

**Khi một lệnh bị chặn mà bạn tin là oan:**

1. Đọc lý do trong prompt/tool result — nó nêu `ref` và tier.
2. `tail ~/.harness/eso-blockers.jsonl` để thấy quyết định đã ghi.
3. Nếu là finding: ghi marker tại nguồn (`tenant:global`, `breaking:approved`) — đừng nới ngưỡng.
4. Nếu là tier: sửa `paths` trong `.harness/decision-policy.json` (thay thế, không nối).

**Khi cài hoặc nâng cấp DSH plugin:** build → `plugin_manager install_bundle` với **absolute
package dir** → `harnessctl doctor dsh`. Sửa code plugin phải `remove_bundle` → bump version →
`install_bundle`; HMR không reload bundle.

---

## 8. Khi có sự cố

| Triệu chứng | Nguyên nhân thường gặp | Kiểm bằng |
|---|---|---|
| Không có hook nào chạy | tree chưa nối, hoặc hook config bị ghi đè | `harnessctl verify host .` → H0/H1 |
| `verify host` H2 fail | preflight chưa từng chạy trong session này | gửi một prompt rồi kiểm lại |
| Evidence luôn `insufficient` | provider không truy cập được (MCP/docgraph) | `harnessctl capability probe .` |
| Write bị chặn dù file vô hại | path rơi vào `locked`/`gated` theo policy hiện tại | `harnessctl verify consumer . --strict` |
| Mọi tool call trong DSH chết với `prepare` | profile có bản sao package app đã ship | `harnessctl doctor dsh` → `pathology-present` |
| Guide này cũ | template đã đổi, consumer chưa sync | `harnessctl fix docs .` |

Nếu `doctor dsh` báo `pathology-present`: **dừng**, đừng cài thêm plugin, xử lý theo hướng dẫn của
lệnh đó (gỡ dependency trùng / cách ly `node_modules`) rồi mới chạy lại.

---

## 9. Ranh giới và bảo đảm

- **Không sửa host.** Với DSH, ESO chỉ là một plugin dùng API công khai (`ctx.on`,
  `workingDirectory`); không patch `app.asar`, không sửa profile bằng tay.
- **Không kéo dependency của host vào profile.** Một bundle tự chứa (0 dependency) là điều kiện để
  không tạo instance thứ hai của package dùng `Symbol()` — nguyên nhân lỗi `prepare`.
- **Không quyết định bằng score.** Score để mô tả; gate dựa trên tier và finding.
- **Không tự kết thúc hội thoại** trừ khi có hard blocker; mọi lỗi nội bộ được bắt và ghi log.
- **Không đọc record từ session.** Record tin cậy nằm ở `~/.harness/`.

---

## 10. Đồng bộ tài liệu này

File này được copy từ `profiles/templates/WORKFLOW_GUIDE.md` của harness-eso **khi provision**; nó
không tự cập nhật. Sau khi nâng cấp harness-eso:

```bash
harnessctl fix docs .     # sync guide + checklist + diagnostics.sh, không đổi policy
```

Không sửa trực tiếp file này trong consumer: lần sync sau sẽ ghi đè.
