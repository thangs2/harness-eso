---
name: angular-standard
description: >-
  Highest-standard Angular 22 UI architecture and delivery rules for the ESO control plane (D-72).
  Normative MUST/NEVER rules for standalone/signals, state, contract client, UX states, accessibility,
  security, performance, testing and CI. Overrides any existing repo code; use when building or reviewing eso/ui.
---

# Angular standard — highest bar

## 0. Precedence

1. `D-72` (Angular 22 + Fuse, monorepo `eso/ui`), `D-74` (v2 does not import v1 UI), API contract → **law**.
2. **This skill** → the engineering standard.
3. Existing repo code → **legacy, not a pattern**. If code disagrees with this skill, the skill wins; open a refactor ticket.

Keywords: **MUST**, **MUST NOT**, **SHOULD**, **NEVER** (RFC 2119).

## 1. Modular structure — MUST

### 1.1 Cây thư mục theo tier

```text
eso/ui/
  apps/control-plane/src/app/
    core/                 # singleton: auth, config, interceptors, guards, error handler
    shared/               # dumb UI dùng lại: state-frame, button, directive, pipe
    layout/               # shell, nav, page frame
    features/
      s1-work/
        pages/            # routed smart component
        components/       # presentational dumb
        data/             # data service gọi generated client
        models/           # view model (không phải API DTO)
        state/            # signal store
        routes.ts
      s2-why/  s3-config/  s4-debt/  s5-artefact/
  libs/api-client/        # generated only — không sửa tay
```

### 1.2 Placement — một file chỉ thuộc một tier

| File | Folder duy nhất | Cấm |
|---|---|---|
| `*.page.ts` | `features/<f>/pages/` | không gọi `HttpClient` trực tiếp |
| `*.component.ts` | `features/<f>/components/` hoặc `shared/` | không inject data service |
| `*.service.ts` | `features/<f>/data/` hoặc `core/` | không chứa template |
| `*.store.ts` | `features/<f>/state/` | không gọi HTTP |
| `*.model.ts` | `features/<f>/models/` | không import generated DTO |
| `*.routes.ts` | feature root | chỉ route |
| `*.guard.ts`, `*.interceptor.ts` | `core/` | không business logic |

- **NEVER** đặt page/component và service trong cùng folder.
- Feature **không** import feature khác; chỉ qua `shared/` hoặc port trong `core/`.
- `shared/` không import `features/`; `core/` không import `features/`.

### 1.3 SOLID — áp cụ thể

| Nguyên tắc | Luật trong code |
|---|---|
| **SRP** | Page orchestrate; component render; service fetch; store giữ state |
| **OCP** | Mở rộng bằng feature/strategy mới; không thêm `@Input() mode` vào shared component |
| **LSP** | Component/interface con thay được cha; không `instanceof` để phân nhánh |
| **ISP** | Input/output nhỏ; cấm truyền god object; tách component khi >7 input |
| **DIP** | Phụ thuộc `InjectionToken`/abstract class; feature không import implementation của feature khác |

### 1.4 Cưỡng chế

- `dependency-cruiser`/Nx boundaries: feature ↔ feature cấm; `shared` → feature cấm; `core` → feature cấm.
- ESLint `no-restricted-imports` + `boundaries`.
- `scripts/check-structure.mjs` (phải có khi scaffold): file sai folder = fail.
- CI đỏ = không merge.

## 2. Angular 22 conventions — MUST

- **Standalone components**; no new `NgModule`.
- `ChangeDetectionStrategy.OnPush` on every component.
- `inject()` for DI; **NEVER** constructor parameter injection in new code.
- Signal inputs/outputs: `input()`, `input.required()`, `output()`, `model()`.
- Control flow `@if` / `@for` / `@switch`; `@for` **MUST** have `track`.
- Typed reactive forms only; **NEVER** `FormBuilder` with untyped `any`.
- Functional guards/interceptors; `provideRouter`, `provideHttpClient(withFetch())`.
- Lazy `loadComponent` / `loadChildren` for every feature route.
- Zoneless-safe: no reliance on `zone.js` patching; if the workspace enables zoneless, the app MUST build and test zoneless.
- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`; **no `any`**.

## 3. State — MUST

- Local state = `signal`; derived state = `computed`; `effect` only for side effects (logging, storage), never to derive state.
- Server state through a typed data service (`resource`/`httpResource` when the workspace enables it); **NEVER** duplicate server state in a store.
- Global store only for cross-feature state; one store per bounded concern; no god-store.
- No `BehaviorSubject` for UI state; no manual subscribe without `takeUntilDestroyed`.
- Loading/error/empty are **state**, not booleans scattered across components.

## 4. API & contract — MUST

- Client generated from OpenAPI/JSON Schema into `libs/api-client`; **NEVER** hand-write DTOs or URLs.
- Regeneration is a build step; CI fails on contract drift; breaking change fails the build.
- `HttpClient` only inside the data layer; **NEVER** in a component.
- Interceptors: auth token, correlation/`traceId`, error normalization, retry only idempotent GETs.
- Timeouts and cancellation on navigation; no request waterfall when `forkJoin`/`resource` is correct.
- Errors map to typed app errors; **NEVER** swallow an HTTP error.

## 5. UX states — MUST

Every screen implements all six (`sdlc/08.ui-design/03.states.md`):

| State | Required | Forbidden |
|---|---|---|
| `ST1 empty` | "chưa có …" + next action | empty table |
| `ST2 loading` | skeleton; controls disabled; **one** request | duplicate request on second click |
| `ST3 failed` | failure message + retry | partial table |
| `ST4 denied` | one sentence for not-found **and** no-permission | leaking existence; reusing the ST1 sentence |
| `ST5 partial` | `⚠ N missing` on the exact row + coverage | false certainty |
| `ST6 stale` | stale/low-coverage warning | rendering as fresh |

- Read-only surfaces (`S1`, `S2`, `S5`) **MUST NOT** render any write control.
- `S3` save **MUST** stay disabled until a preview exists; stale hash ⇒ 409 handled with reload, never blind retry.
- Presets **MUST NOT** overwrite values the user edited; impact across projects shown before save.
- **NEVER** hardcode fixture values (`0.62`, sample rows) in product code.

## 6. Accessibility — MUST

- WCAG 2.2 AA: semantic HTML, labels, keyboard operable, visible focus, 4.5:1 contrast.
- Every interactive element is a real `<button>`/`<a>`; **NEVER** a clickable `<div>`.
- Focus moves to the error summary on failure; focus returns on dialog close.
- Errors announced via `aria-live`; form fields use `aria-describedby`.
- Respect `prefers-reduced-motion`; no motion-only state signal.
- Test with axe; zero serious/critical violations.

## 7. Security — MUST

- **NEVER** `innerHTML` with untrusted data; use Angular interpolation; sanitize with `DomSanitizer` only when unavoidable.
- No secrets/tokens in the bundle; bearer tokens in memory, refresh via HttpOnly cookie; **NEVER** `localStorage` for tokens.
- Route guards are UX, **not** authorization; the API is the authority.
- CSP + Trusted Types where supported; no `eval`, no `new Function`.
- Validate/sanitize URLs; block `javascript:`; allow-list external hosts.

## 8. Performance — MUST

- Lazy routes + `@defer` for below-the-fold heavy blocks.
- `NgOptimizedImage` for images; explicit width/height; modern formats.
- `@for` with stable `track`; no function calls in templates; memoize derived data with `computed`.
- Virtual scroll for lists > 200 rows; pagination mandatory.
- Budgets in `angular.json` (initial bundle, per-route, LCP/INP/CLS); CI fails on breach.
- No heavy work in components; offload to workers for CPU-bound tasks.

## 9. Style — MUST

- Angular style guide: file per concept, `feature.component.ts` / `.service.ts` / `.routes.ts`.
- Soft limit 400 lines per file; no file with two unrelated responsibilities.
- No logic in templates beyond simple conditions; no `any`; no `as` casts to silence types.
- `async` pipe or signals for async data; no manual unsubscribe.
- ESLint (`angular-eslint`) + Prettier; zero warnings in CI.

## 10. Testing — MUST

| Level | Tool | Rule |
|---|---|---|
| Unit | `TestBed` + component harness | DOM behaviour, not object constants |
| Data | `provideHttpClientTesting` | request shape + error mapping |
| Contract | generated client + OpenAPI | response schema validated |
| E2E | Playwright | real route → state → action → result |
| A11y | axe | zero serious/critical |

- Every AC has a happy **and** a negative case.
- `ST1–ST6` each have a test; `ST4` asserts denied ≠ empty.
- **NEVER** snapshot a constant; **NEVER** assert only `notEqual` without constraining the value.
- Coverage gates: overall ≥80%, critical features ≥90%, no drop.

## 11. Delivery — MUST

- CI: `lint` → `typecheck` → unit → e2e → build → bundle budgets → a11y → contract drift.
- PRs small; conventional commit with ticket id `[ESO-xxx]`; no merge on red CI; no `--no-verify`.
- Feature flags for risky screens; rollback plan in the PR.

## 12. Review checklist — all MUST be yes

- [ ] Standalone + OnPush; no NgModule added
- [ ] Signals/computed; no duplicated server state
- [ ] Contract client only; no hand-written DTO/URL
- [ ] All six states implemented; denied ≠ empty; read-only has no write control
- [ ] S3 preview-before-save; 409 handled
- [ ] Keyboard + axe clean; focus managed
- [ ] No `innerHTML`; no token in localStorage
- [ ] Lazy route; budgets not raised
- [ ] Happy + negative tests; DOM assertions
- [ ] No fixture hardcoded

## 13. Anti-patterns — bad → good

| Bad | Good |
|---|---|
| component calls `HttpClient.get('/api/...')` | data service + generated client |
| `BehaviorSubject` for page state | `signal` + `computed` |
| `innerHTML = row.html` | interpolation / sanitized component |
| test asserts `page.rows.length === 3` only | test asserts rendered rows, actions and navigation |
| guard hides a button and calls it authorization | API enforces policy; guard is UX |
| `setTimeout` to "wait for data" | `resource`/signal state |

## 14. References

- Angular official style guide · Angular 22 release notes (standalone, signals, control flow, zoneless)
- Angular CDK testing harness · Playwright · axe-core · WCAG 2.2 AA
- OpenAPI 3.1 client generation · `D-72` · `D-74`
- `sdlc/08.ui-design/03.states.md` · `sdlc/06.analysis/03.acceptance-criteria/50…54.ui-us-*.md`
- Stack gate: `sdlc/09.wbs/00.jira/05.fix-plan-eso-368-389.md` §0.1
