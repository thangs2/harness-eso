# JSON wrapper leakage in assistant messages — measured defect report

**Date:** 2026-10-23
**Scope:** Cursor agent host (message serialization), all workspaces on this machine
**Out of scope:** `harness-eso`, `deepseek-direct` MCP — both excluded below with evidence
**Reporter:** agent session `017bf544` (workspace `x79`)

---

## 1. Symptom

Assistant replies are rendered verbatim as a compact JSON array instead of markdown:

```
[{"text": "… reply text …", "type": "text"}]
```

Inside the stored string every newline is escaped (`\n`), so all markdown structure
(headings, lists, tables, fences) is destroyed. A variant with an empty payload also occurs:

```
[{"text": "", "type": "text"}]
```

The user sees the wrapper itself, not the content.

---

## 2. Trigger condition

A text block is serialized through this wrapper **if and only if the same assistant turn
already emitted a tool call**, i.e. the text is the turn's closing message after tool results
came back.

Across every agent transcript on this machine:

| Position of the text block within the turn | clean | wrapped | rate |
|---|---|---|---|
| first message of the turn (before any tool) | 4 923 | 4 | 0.1% |
| turn emitted only text, no tool | 7 | 0 | 0% |
| **turn emitted a tool call at some point** | 29 856 (non-text blocks dominate) | **127** | — |

All 131 wrapped messages observed sit in the third row. No wrapped message was ever the first
message of its turn.

### Isolating case (deterministic)

Session `3a6c20c1` (workspace `harness-eso`), lines 915–916:

```
915  assistant  [ {text, "Tiếp tục — cập nhật docs rồi build lại."}, {tool_use, Read} ]
916  assistant  [ {text, "[{\"text\": \"\", \"type\": \"text\"}]"} ]
```

A clean text block and a tool call in one message, then an extra text block on the next line
that is only the wrapper of an **empty** string. The host therefore appends a block after tool
execution and serializes that appended block as JSON.

---

## 3. Frequency

Per session, counting assistant text blocks that carry content:

```
session     texts  wrapped   rate
595973e2        5        1    20%
34eb6e4b       19        6    32%
55066ff1       18        4    22%
d48c05b5       11        3    27%
2c3cc0d5        8        2    25%
31eba534       18        8    44%
3a6c20c1       88       48    55%   harness-eso
8384c4e0        7        1    14%
8d37069c      104       49    47%
017bf544       24        8    33%   x79 (this session)
e32047d0        7        1    14%
```

Total: **131 / 309 = 42 %**. Sessions span 5 workspaces — `harness-eso`, `x79`, `FinESO`,
`baplatform`, `atrievefin` — so the defect is host-wide, not workspace- or project-specific.
It is not deterministic per trip: two turns under identical conditions can differ, which is
why the rate varies 14–55 % instead of being 0 or 100 %.

---

## 4. Eliminations

### 4.1 `deepseek-direct` MCP (`installation/deepseek/server/deepseek-direct.mjs`)

The model-side payload was reproduced exactly — stream, a single `user` message, no `system`,
`thinking` enabled/disabled × `reasoning_effort` high/max:

```
thinking enabled   high   content=221  reasoning=829   leaks=CLEAN
thinking enabled   max    content=235  reasoning=1008  leaks=CLEAN
thinking disabled  high   content=260  reasoning=0     leaks=CLEAN
thinking disabled  max    content=262  reasoning=0     leaks=CLEAN
```

No `[{"text"` and no `"type": "text"` in any output. The server itself returns
`{content:[{type:"text",text:…}]}`, i.e. the MCP envelope the host is supposed to *unpack* —
the wrapper is the envelope, not model text.

`~/.harness/deepseek-usage.jsonl` records no calls on 2026-10-23 other than two smoke tests at
02:38Z, while the wrapped replies appeared at 02:44Z and 03:11Z. The MCP server did not run
for those replies.

### 4.2 Message shape

Every wrapped message contains exactly **one** text block. It is not a concatenation of
several blocks, and not a second text block after a tool call inside the same message — the
wrapper is applied per message, to the message that closes a tool-using turn.

### 4.3 Raw storage

The stored value is compact JSON with escaped newlines and no literal `\n` character in it —
verified on the last stored reply (2 698 chars, `contains literal newline: false`, tail ends
with `, "type": "text"}]`). The wrapper is written by the host, upstream of any renderer.

---

## 5. Impact

- Every markdown reply after a tool call is unreadable (structure lost).
- Empty variants (`[{"text": "", "type": "text"}]`) appear as blank bubbles.
- Wrapped text is also re-fed to the model on the next turn, so the model sees its own prior
  answer as a JSON string — a correctness hazard, not only a display defect.
- Rate 42 % at session level means nearly one in two closing summaries is corrupted.

---

## 6. Request to the host vendor

1. A text block produced after tool execution in the same turn should be serialized as plain
   text (`text: "…"`), never as a JSON string of its own content block array.
2. Empty text blocks should be dropped, not serialized (`[{"text": "", "type": "text"}]`).
3. Regression fixture: a turn with `text` + `tool_use`, then a closing `text` — the closing
   text must reach storage as plain markdown.

**Reproduction artefacts on the reporting machine** (paths relative to
`~/.cursor/projects/`):

```
Users-thangs2net-Workspaces-harness-eso/agent-transcripts/3a6c20c1-39fb-4d1a-be58-42a27ea417ba/  lines 915–916
Users-thangs2net-Workspaces-x79/agent-transcripts/017bf544-06e3-4d08-9352-582f9dfc135a/          lines 44,45,86,105,141,207,223,256
```

---

## 7. Relation to `harness-eso`

None. The defect reproduces in four other workspaces that do not load the ESO host pack, and
in this session it reproduces with the DeepSeek MCP excluded by ledger. Recorded here only
because this is where the audit trail for these sessions lives.
