# comments/artifacts — review artifacts (not documentation)

Files here are **evidence for a review**, usually written by an agent about its own session.
They are **not** part of the documentation pack in [`../documents/`](../documents/).

- A doc in `documents/` states how the system **is**; a file here records what **happened** in one
  session, including the agent's own mistakes.
- Nothing here is law, contract, or install instruction. If a file here and the code disagree,
  **the code is right**.
- Delete freely once the review that produced it is closed.

| File | What it is |
|---|---|
| `analysis-2026-10-22-source-attribution-matrix.md` | **Derived analysis, not evidence** — reads the four session logs below against the code and assigns every finding an owner: **P1–P10** = `harness-eso`, **C1–C9** = consumer, **N1–N13** = not a defect / does not reproduce, plus the agent-side patterns. Corrects two misdiagnoses that appear in three logs (the "first tool round only" closure claim, and the bare-`python` hook command). Start here if the question is "whose bug is this". |
| `agent-session-log-2026-10-22-x79-smoke.md` | Agent session log on consumer `x79` (2026-10-22): preflight verdict, gap closure, observe API probes, consumer maturity **T2**, 4 runtime findings (F-A…F-D) and 6 agent self-audit defects (A-1…A-6). |
| `agent-session-2026-10-22T1245Z/turn.jsonl` | Raw `route-trace.jsonl` rows for generation `6365c392…` (43 rows). `user_email` redacted; prompts, paths and tool names verbatim. |
| `agent-session-2026-10-22T1245Z/eso-preflight.json` | `.cursor/session/.eso-preflight.json` snapshot, as written by the hook at turn start. |
| `agent-session-2026-10-22T1245Z/eso-gap-closure.json` | `.cursor/session/.eso-gap-closure.json` snapshot. |
| `agent-session-2026-10-22T1245Z/eso-bundle-stamp.json` | `.cursor/session/.eso-bundle-stamp.json` snapshot. |
| `fineso/agent-session-log-2026-10-22-fineso-envcheck.md` | Agent env-check on consumer `fineso` (2026-10-22): read-only "is harness-eso applied here?" session on the only **T5** consumer. Consumer maturity re-run `pass=25 fail=0`, observe **PASS** on `:8794`, host-pack hashes verified, preflight `score 0.183 → 0.85` shown to be closure bookkeeping rather than measurement, and the consumer's own **dual-harness gate red (exit 1)** with 6/7 `.md`/`.mdc` twins describing *different* rules. 13 runtime findings (F-1…F-13) and 7 agent self-audit defects (A-1…A-7, incl. a guard probe shaped like an attack that the guard correctly blocked). |
| `fineso/agent-session-log-2026-10-22-fineso-envcheck-addendum.md` | Follow-up probes on `fineso` (2026-10-22, §5/§6): official `token-diet` **FAILS** on both trees (`fineso.engineering-slp` declares both `alwaysApply: true` and `globs`) where a hand-rolled `rg` count had said PASS; `stop` row confirmed at generation close (98 rows, `status: completed`, `cache_read 97.5 %`); trace-growth/ingest-cost baseline (~1,790 rows on 22 Oct, idle poll 614 ms). |
| `fineso/agent-session-2026-10-22T1324Z/turn.jsonl` | Raw `route-trace.jsonl` rows for generation `26c1faf8…`, re-extracted **at generation close** (98 rows: 1 `beforeSubmitPrompt` · 92 `postToolUse` · 4 `afterFileEdit` · 1 `stop`). `user_email` redacted; prompts, paths and tool names verbatim. |
| `fineso/agent-session-2026-10-22T1324Z/eso-preflight.json` | Preflight verdict as written by the hook at turn start (`13:24:25Z`). |
| `fineso/agent-session-2026-10-22T1324Z/eso-gap-closure.json` | Gap closure, `allClosed: true` at `13:30:39Z`. |
| `fineso/agent-session-2026-10-22T1324Z/eso-bundle-stamp.json` | Verdict mirror: `allowWrite: true`, `level: sufficient`, `score: 0.85`. |
| `fineso/agent-session-2026-10-22T1324Z/consumer-maturity-latest.md` | Consumer's `.harness/diagnostics/latest.md` **produced by a fresh `verify-consumer.sh fineso`** in this session (not a stale snapshot). |
| `x79/agent-session-log-2026-10-22-x79-audit-diagnostic.md` | Agent audit-diagnostic on consumer `x79` (2026-10-22, **second pass**, read-only, **reviewed 2026-10-23**). Tests internal consistency rather than "does it answer": the `guard-shell.py`/pack shells disagree on `rm -rf …/00.law`; the gap-closure model closes `law:*` only by rule-filename coincidence and counts a `.sh` or `.md` copy as a project-source read. 5 pack findings (F-01…F-05), 8 consumer findings (F-06…F-13 incl. `AGENTS.md` telling agents the preflight hook is absent while 9 pack hooks are installed, and consumer `paths` dropping `backend/mu-*` + `frontend/` + `document/mu/` from `gated`), 5 corrections to the earlier x79 log, **7 agent self-audit defects** (incl. writing synthetic hook payloads into the consumer's session state). The review corrected three causes: the `mode` disagreement is a dropped `policy` argument plus `preflight.mode` never being read (not two projections), `guard-brain` is not a write gate (it returns before reading the policy), and gap closure is per-turn rather than self-resetting. |
| `atrievefin/agent-session-log-2026-10-22-atrievefin-envcheck.md` | Agent env-check on consumer `atrievefin` (2026-10-22): read-only "is harness-eso applied here?" session. Preflight `score 0` / `fail_closed`, runtime **PASS** on port 8795, consumer maturity **T2** (`pass=18 fail=7`), 7 runtime findings (F-1…F-7, incl. gap-closure reproducing `x79` F-C) and 6 agent self-audit defects (A-1…A-6, incl. plaintext Jira token read from `.mcp.json`). |
| `atrievefin/agent-session-2026-10-22T1320Z/turn.jsonl` | Raw `route-trace.jsonl` rows for generation `8979ccee…` (23 rows). `user_email` redacted; prompts, paths and tool names verbatim. |
| `atrievefin/agent-session-2026-10-22T1320Z/consumer-maturity-latest.md` | Consumer's own `.harness/diagnostics/latest.md`, copied at `13:02Z` — a snapshot, not a re-run (see §6.1 of the log). |

Naming: **no numeric prefix.** Numbers (`NN.topic.md`) are reserved for the `documents/` pack and
collide with existing entries there (`25.pilot-rounds-1-3.md` already exists in `08.archive/`).

Read order: the `.md` first — it quotes the JSON and does not require opening them.
