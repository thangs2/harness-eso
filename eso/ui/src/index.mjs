/**
 * @mu/eso-ui — Control Plane UI (Angular 22 / Fuse Monorepo)
 */
import '@angular/compiler';

// Legacy exports for compatibility
export { S1WorkOverviewComponent } from '../dist/src/app/modules/s1-work-overview/s1-work-overview.component.js';
export { S1WorkOverviewClient } from '../dist/src/app/modules/s1-work-overview/s1-work-overview.service.js';

// Angular 22 Standard Architecture (D-72 / SKILL.md)
export * from '../dist/apps/control-plane/src/app/core/index.js';
export * from '../dist/apps/control-plane/src/app/shared/index.js';
export * from '../dist/apps/control-plane/src/app/layout/index.js';
export * from '../dist/apps/control-plane/src/app/features/s1-work/index.js';
export * from '../dist/apps/control-plane/src/app/features/s2-why/index.js';
export * from '../dist/apps/control-plane/src/app/features/s3-config/index.js';
export * from '../dist/apps/control-plane/src/app/features/s4-debt/index.js';
export * from '../dist/apps/control-plane/src/app/features/s5-artefact/index.js';
export * from '../dist/libs/api-client/index.js';
