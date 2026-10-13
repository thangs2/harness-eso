---
description: Supreme gate — Cursor rules load first; agent MUST Read AGENTS.md before work
layer: core
alwaysApply: true
version: "1.0.0"
canonical: AGENTS.md
---

# Law gate (forced)

**Cursor injects `.cursor/rules/` → this rule runs first.** Rules do **not** replace law; they route the agent to it.

## Mandatory (every Agent session)

1. **`Read` repository root `AGENTS.md`** (full file) before planning, MCP recon, or any **Write** / **StrReplace**.
2. Treat **`AGENTS.md` as supreme law** for this repo. `.cursor/rules/*` and skills **summarize** it only.
3. On conflict: **`AGENTS.md` > any rule > any skill > chat guesswork**.

## After `AGENTS.md` is loaded

Apply always-on rules **in this order** (pointers only — details live in `AGENTS.md`):

1. `core.workspace-isolation.mdc`
2. `core.harness-agents.mdc`
3. `core.harness-product.mdc`

Then glob-matched rules and skills **only if** they do not contradict `AGENTS.md`.

## Same session

If the user changes scope (observe API, consumer E2E, new package), **re-read `AGENTS.md`** when its sections (tools, layout, verify) become relevant — do not rely on rule memory alone.

## Not law

`.cursor/instructions.md` is a catalog index only — not a substitute for `AGENTS.md`.
