import type { Routes } from '@angular/router';

export const APP_ROUTES: Routes = [
    {
        path: '',
        redirectTo: 'work-overview',
        pathMatch: 'full',
    },
    {
        path: 'consumers',
        loadChildren: () => import('./features/consumers/consumers.routes.js').then((m) => m.CONSUMERS_ROUTES),
    },
    {
        path: 'onboarding',
        loadChildren: () => import('./features/onboarding/onboarding.routes.js').then((m) => m.ONBOARDING_ROUTES),
    },
    {
        path: 'work-overview',
        loadChildren: () => import('./features/work-overview/work-overview.routes.js').then((m) => m.WORK_OVERVIEW_ROUTES),
    },
    {
        path: 'diagnosis',
        loadChildren: () => import('./features/diagnosis/diagnosis.routes.js').then((m) => m.DIAGNOSIS_ROUTES),
    },
    {
        path: 'declaration',
        loadChildren: () => import('./features/declaration/declaration.routes.js').then((m) => m.DECLARATION_ROUTES),
    },
    {
        path: 'risk',
        loadChildren: () => import('./features/risk/risk.routes.js').then((m) => m.RISK_ROUTES),
    },
    {
        path: 'audit',
        loadChildren: () => import('./features/audit/audit.routes.js').then((m) => m.AUDIT_ROUTES),
    },
];
