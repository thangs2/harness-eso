# Skills — harness-eso

**Skills sống ở `.cursor/skills/` và bản mirror `.agents/skills/`** — hai bản phải giống nhau; không dùng `x79/.cursor/skills/mu-*` hay `brain-dispatch` trong window này.

Procedures live here; **law** lives in `../x79/document/harness/02.harness-eso/` and `.cursor/rules/`.

| Skill | When | SoT |
|-------|------|-----|
| `harness-eso-implement` | Feature/fix trong monorepo | `AGENTS.md`, `core.harness-eso-spec`, x79 `02.harness-eso/` |
| `harness-verify` | Sau đổi observe/docker/hooks | `docs/01.overview/02.cursor-windows.md`, `docker/README.md` |
| `harness-engineering-team` | Ticket chạm >1 package/tầng — SLP: scout → plan → build×N → verify → audit → qc | `core.slp.mdc` · `.cursor/agents/*-runtime.md` |
| `nestjs-standard` | **Highest standard** NestJS 11 + Fastify + Kysely (D-71); normative, overrides repo code | `D-71` · `sdlc/07.technical/03.api` |
| `paseo-recon` | Session do Paseo spawn (`PASEO_AGENT_ID`): profile mount gì, codegraph/docgraph CLI per-cwd, thêm MCP vào profile | `core.paseo-provider.mdc` |
| `angular-standard` | **Highest standard** Angular 22 + Fuse (D-72); normative, overrides repo code | `D-72` · `sdlc/08.ui-design` |

**x79-only** (không copy vào repo này): `brain-dispatch`, toàn bộ `mu-*` — mở window x79.

MCP wiring: `core.harness-tooling.mdc`.
