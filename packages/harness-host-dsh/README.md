# @mu/harness-host-dsh

Host shim for DeepSeek Harness (DSH).

## What is here

| File | Role |
|---|---|
| `src/memory-provider.mjs` | `createDshSessionMemory()` — wraps a host session-search function as a **native** ESO provider (`memory`), with provenance (`sessionId`, `seq`) and a deliberate `ceiling` (0.65) |

The package is intentionally dependency-free: the Cordis plugin owns the DSH context and injects
`searchEvents`. That keeps the adapter testable without a running Harness and avoids pinning this
package to a DSH prerelease.

## Policy

```json
{
  "eso": {
    "sources": {
      "memory": {
        "enabled": true,
        "prefer": ["native"],
        "fallback": ["agentmemory-mcp", "none"]
      }
    }
  }
}
```

With the DSH plugin registered, `prefer: ["native"]` binds `native:dsh-session`; without it the same
policy falls through to `agentmemory-mcp`, then to no memory at all.

## Not here yet

The Cordis plugin (hook wiring: preflight, guards, route) and the DSH host-pack bridge are the next
milestone — see `documents/05.development/19.plan-dsh-integration.md` and
`documents/05.development/26.advanced-program.md`.
