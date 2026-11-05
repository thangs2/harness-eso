---
name: nestjs-standard
description: >-
  Highest-standard NestJS 11 + Fastify + Kysely architecture and delivery rules for the ESO control plane (D-71).
  Normative MUST/NEVER rules for modules, layers, validation, errors, auth, persistence, observability, performance,
  testing and CI. Overrides any existing repo code; use when building or reviewing anything under eso/control-plane.
---

# NestJS standard — highest bar

## 0. Precedence

1. `D-71` (NestJS + Fastify + Kysely on Node), `D-73` (Postgres 3 DB), API contract → **law**.
2. **This skill** → the engineering standard.
3. Existing repo code → **legacy, not a pattern**. If code disagrees with this skill, the skill wins; open a refactor ticket.

Keywords: **MUST**, **MUST NOT**, **SHOULD**, **NEVER** (RFC 2119).

## 1. Modular structure — MUST

### 1.1 Cây thư mục theo tier

```text
src/
  main.ts
  app.module.ts
  config/                         # typed config + schema
  common/                         # cross-cutting framework code
    filters/  interceptors/  guards/  pipes/  decorators/
  modules/
    <domain>/
      <domain>.module.ts          # composition root — file duy nhất ở root
      index.ts                    # public API của module (chỉ export port/use-case được phép)
      api/                        # TIER 1 — transport
        controllers/
        dto/
        presenters/
      application/                # TIER 2 — orchestration
        use-cases/
        services/
        ports/                    # interface: repository, clock, id, event bus
      domain/                     # TIER 3 — pure business
        entities/
        value-objects/
        services/
        events/
        errors/
      infrastructure/             # TIER 4 — adapters
        persistence/
          repositories/           # Kysely implementation
          mappers/
          queries/
        external/
      test/
        unit/  integration/  e2e/
```

### 1.2 Placement — một file chỉ thuộc một tier

| File | Folder duy nhất | Cấm |
|---|---|---|
| `*.controller.ts` | `api/controllers/` | không nằm cạnh service/repository |
| `*.dto.ts` | `api/dto/` | không chứa logic |
| `*.presenter.ts` | `api/presenters/` | không query DB |
| `*.use-case.ts` | `application/use-cases/` | không import Nest request |
| application `*.service.ts` | `application/services/` | không SQL |
| `*.port.ts` | `application/ports/` | không implementation |
| `*.entity.ts`, `*.vo.ts` | `domain/entities/` · `domain/value-objects/` | không import framework |
| `*.repository.ts` (impl) | `infrastructure/persistence/repositories/` | không business rule |
| `*.mapper.ts` | `infrastructure/persistence/mappers/` | không query |
| `*.module.ts` | module root | chỉ một file |
| `index.ts` | module root | chỉ export public API |

- **NEVER** đặt `controller.ts` và `service.ts` trong cùng folder.
- **NEVER** đặt DTO trong `domain/` hoặc entity trong `api/`.
- **NEVER** import ngược tier: `domain` không biết `application`, `api`, `infrastructure`.
- **NEVER** deep-import module khác (`modules/a/infrastructure/...`); chỉ qua `modules/a/index.ts`.

### 1.3 SOLID — áp cụ thể

| Nguyên tắc | Luật trong code |
|---|---|
| **SRP** | Controller chỉ HTTP; use-case một operation; repository chỉ persistence; mapper chỉ map |
| **OCP** | Thêm hành vi = thêm use-case/adapter mới; không thêm `if/switch` vào class cũ; strategy qua DI token |
| **LSP** | Mọi implementation của port phải qua contract test; cấm `throw new Error('not supported')` cho method của port |
| **ISP** | Port nhỏ theo khả năng (`ConfigReader`, `ConfigWriter`); cấm port 20 method; consumer chỉ phụ thuộc method nó dùng |
| **DIP** | `application`/`domain` phụ thuộc **interface**; `infrastructure` implement; inject token, cấm `new Kysely()` trong service |

### 1.4 Composition root

- Chỉ `<domain>.module.ts` được `new` implementation và bind port → adapter.
- Cấm service locator, `ModuleRef.get` rải rác, circular `forwardRef`.

### 1.5 Cưỡng chế

- `dependency-cruiser`: `domain` không import `@nestjs/*|kysely|infrastructure|api`; `api` không import `infrastructure`; cross-module chỉ qua `index.ts`.
- ESLint `no-restricted-imports` cho deep import.
- `scripts/check-structure.mjs` (phải có khi scaffold): fail nếu file sai folder hoặc hai tier trong một folder.
- CI chạy cả ba; đỏ = không merge.

## 2. Runtime & platform — MUST

- **Node LTS ≥ 22** serves production. **NEVER** run Nest under Bun (`reflect-metadata`/decorators are unsupported).
- **Fastify adapter**, not Express: `NestFactory.create(AppModule, new FastifyAdapter({...}))`.
- **Kysely** for SQL, not an ORM. No Prisma/TypeORM.
- **REST + OpenAPI 3.1**, not GraphQL.
- `main.ts` MUST: enable graceful shutdown (`app.enableShutdownHooks()`), set body/header limits, disable `x-powered-by`, and validate config before listen.
- Readiness MUST fail until DB + migrations are ready; liveness MUST NOT depend on DB.

## 3. Configuration — MUST

- 12-factor: config from env; **no** `process.env` reads outside the config module.
- Validate at boot with a schema (Zod or Joi); **fail fast** on missing/invalid values.
- Secrets NEVER logged, NEVER in error responses, NEVER in OpenAPI examples.
- One typed `AppConfig` provider; no stringly-typed config access.
- Test/prod parity: same code path, only values differ.

## 4. DTO & validation — MUST

- Global `ValidationPipe`:
  `{ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }`
- DTOs are classes with `class-validator`; **no `any`**; closed enums; ISO-8601 dates.
- Unknown fields → **400**, never silently dropped.
- Response DTOs are explicit; **NEVER** return persistence rows directly.
- Avoid `@Body() body: any` and manual `if` validation.

## 5. Errors — MUST

- Domain errors carry a stable `code`; HTTP mapping lives in **one** exception filter.
- Error body: RFC 9457 `application/problem+json` with `type`, `title`, `status`, `code`, `detail`, `instance`, `traceId`.
- **NEVER** return 200 for a failure; **NEVER** leak stack traces or SQL.
- Unknown errors → 500 with a generated `traceId`; log full detail server-side only.
- Codes are append-only and documented in the API contract; **NEVER invent** a code in a controller.

| Kind | HTTP |
|---|---|
| validation / malformed | 400 |
| unauthenticated | 401 |
| forbidden / policy | 403 |
| not found | 404 |
| conflict / stale version / already closed | 409 |
| rate limit | 429 |
| dependency unavailable | 503 |

## 6. AuthN / AuthZ — MUST

- OIDC/JWT access tokens; validate issuer, audience, expiry, signature (JWKS cache).
- **Deny by default**; a route without an explicit policy is a bug.
- Authorization is **server-side** and policy-based (ABAC: subject, action, resource, project). Client checks are UX only.
- `project`/tenant scope comes from the verified token/context — **NEVER** from body or query.
- Every write records actor, project, action, resource, result (audit event).
- No secrets or PII in logs; redact authorization headers.

## 7. Persistence — MUST

- Three databases `cp · ctx · graph`; **no cross-database joins**.
- **Every query is scoped** by `project`/tenant, including join tables. A query without scope is a security defect.
- Kysely typed schema; migrations versioned and forward-only; destructive migrations require a two-step deploy.
- Transactions at the **use-case** boundary; repositories never commit on their own.
- No `SELECT *`; explicit columns; pagination mandatory; no unbounded lists.
- Indexes proven by `EXPLAIN (ANALYZE)` on realistic data; N+1 is a defect.
- Idempotency: writes accept an idempotency key; same key + same payload ⇒ one effect.

## 8. Observability — MUST

- OpenTelemetry traces, metrics, structured logs (pino), one correlation/`traceId` across HTTP → DB.
- Log fields: `traceId`, `project`, `actor`, `route`, `status`, `durationMs`; no payload bodies with PII.
- Health: `/health/live`, `/health/ready` via `@nestjs/terminus`.
- Metrics: request rate, error rate, p50/p95/p99, DB pool saturation, queue depth.
- SLO: p95 ≤ 800 ms (`MET-04`); alert on burn rate, not on single spikes.

## 9. Performance — MUST

- Fastify JSON serialization schemas on hot routes.
- Cache only with an explicit key, TTL and invalidation rule; no cache without invalidation.
- Streaming/backpressure for large payloads; body size limits.
- Load test every endpoint that touches >1 table; record p95 before/after.
- No synchronous CPU-heavy work on the request path; offload to a worker/queue.

## 10. Security — MUST

- OWASP ASVS L2 baseline: input validation, output encoding, authn/z, session/token, crypto, error handling, logging.
- `helmet`-equivalent headers, CORS allow-list (no `*` with credentials), rate limiting (`@nestjs/throttler`).
- SSRF: allow-list outbound hosts; no user-controlled URLs.
- Dependency audit in CI (`npm audit --omit=dev` or equivalent) with a fail threshold.
- SQL injection is prevented by Kysely parameterization; **NEVER** interpolate identifiers without an allow-list.
- File uploads: type/size limits, no execution, store outside web root.

## 11. Testing — MUST

Test pyramid, all in CI:

| Level | Tool | Rule |
|---|---|---|
| Domain unit | `node:test`/Vitest | pure, no Nest, ≥90% branch on domain |
| Application | fake ports | use-case behaviour, negative cases |
| Integration | real Postgres (Testcontainers) | repositories, migrations, scoping |
| E2E | `@nestjs/testing` + Fastify `inject` | status + problem+json code + side effect |
| Contract | generated OpenAPI | response schema validated |

- Every AC has a happy **and** a negative case.
- **NEVER** assert implementation constants; assert observable behaviour.
- A test that cannot fail on broken code is deleted, not kept.
- Coverage gates: domain ≥90%, overall ≥80%, no drop allowed.

## 12. API contract — MUST

- OpenAPI generated from code (`@nestjs/swagger`), committed, diffed in CI.
- Breaking change requires a version bump and a migration note.
- Standard list contract: cursor/limit, stable sort, `nextCursor`, total only when cheap.
- Idempotency-Key on POST that creates or changes money/state.
- Errors documented per endpoint; examples are real.

## 13. Delivery — MUST

- CI gates, in order: `lint` → `typecheck` → unit → integration → e2e → build → contract diff → dependency audit.
- PRs small and single-purpose; conventional commit with ticket id `[ESO-xxx]`.
- No direct push to main; no merge with red CI; no `--no-verify`.
- Feature flags for risky changes; rollback plan in the PR.

## 14. Review checklist — all MUST be yes

- [ ] Module boundary respected; no cross-module repository import
- [ ] No framework import in domain
- [ ] Every query scoped by project/tenant
- [ ] DTO validated; unknown fields rejected
- [ ] Error code from contract; no 200 on failure
- [ ] AuthZ server-side; project from token
- [ ] Transaction boundary at use-case
- [ ] Trace/log/metric present; no PII
- [ ] Happy + negative test; coverage not down
- [ ] OpenAPI diff reviewed

## 15. Anti-patterns — bad → good

| Bad | Good |
|---|---|
| `controller` runs `db.raw('select ...')` | controller → use-case → repository port |
| `where('id','=',id)` only | `where('project','=',project).where('id','=',id)` |
| `catch (e) { return { ok: true } }` | map to typed error + 5xx problem+json |
| `process.env.X` in service | typed `AppConfig` validated at boot |
| Test asserts `active_requests === 1` | test asserts the HTTP/DOM/DB effect |
| ORM entity returned to client | explicit response DTO |

## 16. References

- NestJS official docs (modules, DI, validation, testing, Fastify adapter)
- Fastify · Kysely · `@nestjs/terminus` · `@nestjs/swagger` · `@nestjs/throttler`
- OWASP ASVS 4.0 L2 · RFC 9457 (problem details) · OpenTelemetry
- `D-71` · `D-73` — `sdlc/03.inception/02.decision-log/06.architecture-va-data.md`
- Stack gate: `sdlc/09.wbs/00.jira/05.fix-plan-eso-368-389.md` §0.1
