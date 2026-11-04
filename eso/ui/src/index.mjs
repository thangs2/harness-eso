/**
 * @mu/eso-ui — Control Plane UI (Angular 22 / Fuse Monorepo)
 *
 * Every path below must match what `tsc` emits (`eso/ui/tsconfig.json`, rootDir `./`). The feature
 * folders were renamed from surface numbers (`s1-work`, `s2-why`, …) to domain names in `cd3fb52`;
 * this barrel kept pointing at the old paths and only resolved while a stale `dist/` from before the
 * rename was still on disk. A clean checkout has no stale `dist/`, so only the renamed paths exist.
 */
import '@angular/compiler';

// Legacy exports for compatibility (built from `src/`, hence the `dist/src/…` prefix).
export { S1WorkOverviewComponent } from '../dist/src/app/modules/s1-work-overview/s1-work-overview.component.js';
export { S1WorkOverviewClient } from '../dist/src/app/modules/s1-work-overview/s1-work-overview.service.js';

// Angular 22 Standard Architecture (D-72 / SKILL.md)
export * from '../dist/apps/control-plane/src/app/core/index.js';
export * from '../dist/apps/control-plane/src/app/shared/index.js';
export * from '../dist/apps/control-plane/src/app/layout/index.js';
export * from '../dist/apps/control-plane/src/app/features/work-overview/index.js';
export * from '../dist/apps/control-plane/src/app/features/diagnosis/index.js';
export * from '../dist/apps/control-plane/src/app/features/declaration/index.js';
export * from '../dist/apps/control-plane/src/app/features/risk/index.js';
export * from '../dist/apps/control-plane/src/app/features/audit/index.js';
export * from '../dist/libs/api-client/index.js';
