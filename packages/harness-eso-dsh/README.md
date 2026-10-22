# @mu/harness-eso-dsh

harness-eso as a DeepSeek Harness plugin. One row in the loader, no DSH file edited, and **no npm
dependencies** after the build — the bundle imports only `node:*`.

## Why there are no dependencies

Installing a plugin whose dependency graph touches an app-shipped package gives the DSH profile a second
instance. `@deepseek-ai/dsh-tools` exports `TOOL_RUNTIME_SCHEDULER` as `Symbol()`, so a second instance
makes `dsh-agent-loop` read `undefined` from `ctx.tools[...]` and **every tool call dies** at
`.prepare(...)` (ATF-OPS-001). A bundle with nothing to install cannot cause that.

## Build

```bash
node scripts/build-dsh-plugin.mjs        # from the repo root
```

Writes `dist/eso-plugin.mjs` (zero external imports), `dist/build.json`, and `cordis.patch.yml`.

## Install

1. **DSH → Plugins → install a bundle**, target this package directory
   (`packages/harness-eso-dsh`).
2. Restart, then check the machine is still healthy:

```bash
harnessctl doctor dsh --profile desktop     # must say healthy
```

3. Open a workspace that has `harness.config.json` (an ESO consumer) and run a tool call.

## What it enforces

| Channel | Wire | Behaviour |
|---|---|---|
| Write (`write`/`edit`/`multiedit`/…) | `tools/pre-execute` | `deny` for a `locked` path, `ask` for `ask` tier or a `gated` path with no live consent |
| Shell (`bash`/`pwsh`/…) | `tools/pre-execute` | same rules, targets resolved from the command with the shared `shell-writes` matcher |
| Prompt | `agent/pre-step` | pass-through today; hard blockers land in P2 |

The rules are the consumer's own `.harness/decision-policy.json`, read per call. A directory that is not
an ESO consumer gets **no opinion** — the plugin never blocks a repo it was not installed for.

## Known limits

- Approval (`ask`) depends on DSH surfacing it; the plugin returns the decision and does not implement UI.
- No prompt gating yet (P2), no context injection (P3), no evidence ledger yet.
- `<unknown>` shell targets are denied rather than allowed: a write with no resolvable target is a write.
