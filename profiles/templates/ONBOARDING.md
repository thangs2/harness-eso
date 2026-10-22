# Harness ESO — Onboarding checklist (per layer)

> **Đọc file này khi:** vừa `provision` xong, hoặc `diagnostics.sh` báo một layer đỏ.
> **Bạn đang tìm reference kiến trúc?** File này là *checklist làm gì*; `WORKFLOW_GUIDE.md` cùng thư mục
> là *reference nó hoạt động thế nào*. Hai file, hai vai, đừng trộn.
>
> Mỗi layer bên dưới trả lời đúng ba câu: **cái gì phải đúng** · **kiểm bằng gì** · **sai thì làm gì**.

---

## 0. Chạy cái này trước

```bash
./.harness/diagnostics.sh            # toàn bộ layer
./.harness/diagnostics.sh L4         # đúng một layer
./.harness/diagnostics.sh --json     # cho CI
./.harness/diagnostics.sh --verbose  # xem cả PASS
```

Script **read-only**: nó không tạo, không sửa, không provision. Exit `1` khi có check `BLOCKER` fail.

Nếu `diagnostics.sh` in ra `harnessctl unavailable`, nó sẽ bỏ qua các check cần `harnessctl`
(`capability`, `verify host`). Bật bằng:

```bash
export HARNESS_ESO_ROOT=/duong/dan/toi/harness-eso   # checkout harness-eso của bạn
```

### Ba mức severity — đọc đúng mức

| Severity | Nghĩa | Không làm thì sao |
|---|---|---|
| `BLOCKER` | thiếu thì harness **không chạy đúng** — hook không fire, hoặc gate không chặn | sửa trước khi làm bất cứ việc gì khác |
| `WARN` | harness chạy nhưng **yếu hơn thiết kế** — bằng chứng thiếu, diet không bật | sửa trước khi tin vào một lần `deny` |
| `INFO` | chỉ báo trạng thái, không có hành động bắt buộc | đọc để biết mình đang ở đâu |

### Layer map

| Layer | Câu hỏi duy nhất của layer | Severity cao nhất có ở đó |
|---|---|---|
| **L0** | Harness đã có mặt trong repo này chưa? | BLOCKER |
| **L1** | Hook của host có thật sự gọi harness không? | BLOCKER |
| **L2** | Luật (AGENTS.md, rules) và law index đã đúng chưa? | BLOCKER |
| **L3** | Bằng chứng (docgraph/codegraph/memory) có nguồn chưa? | WARN |
| **L4** | Preflight có chấm điểm không, và gate có đang mở/đóng đúng? | BLOCKER |
| **L5** | Token diet có bật, và có nằm dưới trần không? | WARN |
| **L6** | Brain tier và MCP server đã nối chưa? | WARN |
| **L7** | Context mỏng — có file nào bị inline quá lớn không? | WARN |
| **L8** | Observe plane có chạy không? | INFO |

Thứ tự **là quan trọng**: L0–L2 là điều kiện của L4 (không có hook thì không có preflight); L3 là điều
kiện của L5 (không có bằng chứng thì diet chỉ tiết kiệm token trên giấy). Làm từ trên xuống.

---

## L0 — Harness có mặt

**Phải đúng:**

| File | Là gì |
|---|---|
| `harness.config.json` | danh tính repo (`project.id`), `server.port` |
| `.harness/decision-policy.json` | luật: `paths`, `eso`, `tokenDiet` |
| `.harness/host-pack/harness-hook.mjs` | bundle hook — **một file, không import ngoài `node:*`** |
| `.harness/host-install-state.json` | tree nào đã nối |
| `.harness/ONBOARDING.md` + `.harness/diagnostics.sh` | file này và script của nó |

**Kiểm:** `./.harness/diagnostics.sh L0`

**Sai thì:**

```bash
hwc provision.sh <consumer>                    # hoặc, trong consumer:
harnessctl init profile . --host-mode dual-ide # --plan để xem trước, không ghi
```

> **Đừng** copy tay `harness-hook.mjs`. Pack được verify sau khi cài; copy tay bỏ qua bước đó và bạn sẽ
> biết khi guard fail-closed chặn mọi lệnh.

---

## L1 — Hook của host gọi harness

**Phải đúng:**

| Tree | File cấu hình | Điều kiện |
|---|---|---|
| Cursor | `.cursor/hooks.json` | có tham chiếu `harness-hook` |
| Antigravity | `.agents/hooks.json` | có tham chiếu `harness-hook` |
| Claude Code | `.claude/settings.json` | có tham chiếu `harness-hook` |
| Cursor / Antigravity | `.<tree>/hooks/guard-write.py` | có mặt nếu tree đó đã nối |
| Cursor / Antigravity | `.<tree>/hooks/guard-shell.py` | có mặt nếu tree đó đã nối |

Tree bạn không dùng thì **không** phải lỗi — diagnostics ghi `SKIP`.

**Kiểm:** `./.harness/diagnostics.sh L1` · sâu hơn: `harnessctl verify host . --json` (H0–H5)

**Sai thì:**

```bash
harnessctl host-pack refresh .    # merge-safe: hook của bạn được giữ nguyên
```

> `H0` fail = config **không trỏ** vào `harness-hook.mjs`. `H1` fail = có trỏ nhưng **không guard nào
> được nối** — pack có mặt mà không ai gọi nó. Hai lỗi khác nhau, sửa khác nhau.

---

## L2 — Luật và law index

**Phải đúng:**

| Hạng mục | Điều kiện | Vì sao |
|---|---|---|
| `AGENTS.md` | tồn tại ở root | law gate bắt buộc Read file này mỗi phiên |
| `.<tree>/rules/*.mdc` | mỗi tree đã nối có ít nhất một rule | rule là bề mặt luật cho agent |
| `docgraph.scope` | **mọi** dòng `path:` trỏ tới path có thật | T3.4 fail nếu khai một Agent Zone không tồn tại |
| law index | `.docgraph/` hoặc `documents/document/` | không có index thì tra law trả rỗng |

**Kiểm:** `./.harness/diagnostics.sh L2`

**Sai thì:**

```bash
harnessctl fix consumer .              # sync rule template + session dirs (auto-safe)
docgraph build                         # sau khi scope đổi
```

> `<tree>` trong toàn bộ file này là `cursor` · `agents` · `claude`. Áp dụng cho tree bạn thật sự dùng.

---

## L3 — Recon trinity (nguồn bằng chứng)

Ba nguồn, ba loại bằng chứng, **không thay thế nhau**:

| Kind | Provider | Trả lời câu | Thiếu thì |
|---|---|---|---|
| law | `docgraph-cli` | "luật/hợp đồng nói gì?" | gap `law:*` không đóng được → write bị chặn |
| code | `codegraph-cli` | "code này gọi ai, đổi nó vỡ gì?" | gap `code:*` không đóng được |
| memory | `agentmemory-mcp` | "phiên trước đã quyết gì?" | **opt-in** — không khai thì resolve `none`; diagnostic báo tên kind, bạn quyết định |

> **`reason=none` ở `memory` là WARN, không phải BLOCKER** — nhưng nếu bạn *đã khai* `agentmemory` trong
> `mcp.json` mà probe vẫn trả `none`, đó là cấu hình sai và gap `memory:*` sẽ không bao giờ đóng. Diagnostic
> liệt kê **mọi** kind chết, không chỉ cái đầu tiên, nên đọc dòng `L3:capability` để biết chính xác cái nào.

**Phải đúng:**

| Hạng mục | Điều kiện |
|---|---|
| `.codegraph/` | có index — nếu không: `codegraph init -i` |
| `.docgraph/` | có index — nếu không: `docgraph build` |
| provider chain | mỗi kind resolve ra một provider, hoặc bạn biết rõ vì sao không |

**Kiểm:**

```bash
./.harness/diagnostics.sh L3
harnessctl capability probe . --json    # kind → selected · reason · candidates
```

`reason` là câu trả lời: `default` / `native` / `id:<provider>` / `none` / `disabled` / `exhausted`.

**Sai thì:**

```bash
codegraph init -i                       # nếu chưa có .codegraph
docgraph build                           # nếu chưa có .docgraph
# memory: thêm sources.memory vào decision-policy.json khi bạn thật sự muốn nó
```

> **Rules / skills có cần không?** Rule là **bắt buộc** (L2). Skill là **tuỳ chọn**: `harness-eso-implement`
> và `harness-verify` giúp agent làm đúng quy trình, nhưng thiếu skill không làm harness sai. Diagnostics
> ghi `SKIP`, không `FAIL`.

---

## L4 — Bằng chứng và gate

**Phải đúng:**

| Hạng mục | Điều kiện | Nghĩa |
|---|---|---|
| preflight | `.<tree>/session/.eso-preflight.json` có `level` + `at` | đã có ít nhất một lượt chấm |
| gap closure | `.eso-gap-closure.json` → `allClosed: true` khi bạn cần ghi path `gated` | còn gap mở = write bị deny |
| verify host | H0–H5 pass (H4/H5 có thể `skip`) | host pack đang thật sự chạy |

**Kiểm:** `./.harness/diagnostics.sh L4` · `harnessctl verify host . --json`

**Sai thì — đọc đúng triệu chứng:**

| Triệu chứng | Nghĩa | Làm gì |
|---|---|---|
| `L4:preflight` SKIP | chưa gửi prompt nào | gửi một prompt rồi chạy lại |
| `L4:gaps` FAIL | bằng chứng chưa đủ cho path bạn định ghi | đọc gap trong `.eso-preflight.json`, đọc đúng law/code nó nêu, rồi thử lại |
| `L4:verify-host` FAIL | hook không chạy hoặc chưa từng chạy | quay lại L1; xem Hn nào fail và `detail` của nó |

> **Đừng** sửa `.eso-preflight.json` hay `.eso-gap-closure.json` bằng tay để "mở khoá". Đó là record
> agent ghi được; gate không tin nó ở chỗ khác, và bạn sẽ tạo ra một consumer trông xanh mà vẫn hỏng.

---

## L5 — Token diet

**Phải đúng:**

| Hạng mục | Điều kiện | Vì sao |
|---|---|---|
| `tokenDiet.enabled` | `true` | không bật = **mọi** rule load eagerly, mỗi lượt |
| `tokenDiet.maxEagerRules` | số **rule eager** ≤ trần | eager = `alwaysApply: true`, hoặc **không** khai `globs` |
| `tokenDiet.maxEagerTokens` | có giá trị | ngân sách context cho rule |

> Số rule trong thư mục **không phải** số eager. x79 có 50 file rule ở `.cursor/rules` nhưng chỉ 4 cái
> load eagerly; 46 cái còn lại khai `globs` nên chỉ nạp khi đụng đúng path. Đếm file là đo sai đại lượng.

**Kiểm:** `./.harness/diagnostics.sh L5` · `harnessctl token-diet . --json`

**Sai thì:**

```bash
harnessctl fix consumer .          # provision seed tokenDiet
harnessctl token-diet .            # xem cái gì đang eager và tốn bao nhiêu
```

> Cách sửa đúng khi vượt trần là **scope rule theo path (glob)**, không phải nâng trần. Nâng trần là
> quyết định có ý thức — nếu bạn làm vậy, ghi lý do vào policy commit message.

---

## L6 — Brain và MCP

**Phải đúng:**

| Hạng mục | Điều kiện |
|---|---|
| MCP config | `.<tree>/mcp.json` (hoặc `mcp_config.json`) có server `deepseek` |
| brain guard | `guard-brain` thấy tier trước khi model được gọi |
| product state | `~/.harness/eso-blockers.jsonl` là nơi trail của mọi lần deny |

**Kiểm:** `./.harness/diagnostics.sh L6` · `tail -n 20 ~/.harness/eso-blockers.jsonl`

**Sai thì:** thêm server `deepseek` vào MCP config theo `docs/03.cursor-mcp.md` của harness-eso.

> `mcp.json` giờ là path **`locked`**: agent không ghi được nó kể cả khi đủ bằng chứng. Nếu bạn cần
> sửa, sửa bằng tay — đó là chủ ý, không phải bug.

---

## L7 — Context mỏng

**Phải đúng:**

| File | Trần thực dụng |
|---|---|
| `.cursor/instructions.md` | ~8 KB — nó là **index**, không phải handbook |
| `.harness/ONBOARDING.md` | < 60 KB (file này) |
| `.harness/WORKFLOW_GUIDE.md` | < 60 KB |

**Kiểm:** `./.harness/diagnostics.sh L7`

**Sai thì:** chuyển chi tiết vào rule/skill (load theo scope), giữ file inline chỉ còn chỉ mục + link.

> Con số 8 KB là **ngân sách**, không phải giới hạn kỹ thuật. Vượt thì không có gì hỏng — chỉ là mỗi lượt
> bạn trả token cho phần lớn nội dung không liên quan.

---

## L8 — Observe plane

**Phải đúng:** `harness.config.json` → `server.port` tồn tại, và nếu bạn muốn xem số liệu thì
`http://127.0.0.1:<port>/health` trả lời.

**Kiểm:** `./.harness/diagnostics.sh L8`

**Sai thì:**

```bash
./harness up                 # trong checkout harness-eso
harnessctl observatory up    # hoặc qua CLI
```

> Observe **không** tham gia quyết định gate. Nó không chạy thì gate vẫn đúng; bạn chỉ mất khả năng nhìn
> lại.

---

## Bảng tra ngược: triệu chứng → layer

| Triệu chứng | Layer | Việc đầu tiên |
|---|---|---|
| Không hook nào chạy | L1 | `harnessctl verify host . --json` → H0 |
| Write bị chặn dù file vô hại | L2 + L4 | xem `paths` trong policy, rồi gap nào còn mở |
| Evidence luôn `insufficient` | L3 | `harnessctl capability probe .` |
| Mọi lượt đều tốn context | L5 | `harnessctl token-diet .` |
| Brain không được gọi | L6 | kiểm MCP config có `deepseek` |
| Không thấy số liệu sau phiên | L8 | `./harness up` |
| Guide/checklist này cũ | L0 | `harnessctl fix docs .` |

---

## Đồng bộ file này

File này được copy từ `profiles/templates/ONBOARDING.md` của harness-eso **khi provision** và **không tự
cập nhật**. Sau khi nâng cấp harness-eso:

```bash
harnessctl fix docs .     # sync ONBOARDING + diagnostics.sh + WORKFLOW_GUIDE
```

Không sửa trực tiếp trong consumer: lần sync sau sẽ ghi đè.
