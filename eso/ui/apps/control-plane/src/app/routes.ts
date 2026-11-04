import type { Routes } from '@angular/router';

export const APP_ROUTES: Routes = [
    {
        path: '',
        redirectTo: 's1-work',
        pathMatch: 'full',
    },
    {
        path: 's1-work',
        loadChildren: () => import('./features/s1-work/s1-work.routes.js').then((m) => m.S1_WORK_ROUTES),
    },
    {
        path: 's2-why',
        loadChildren: () => import('./features/s2-why/s2-why.routes.js').then((m) => m.S2_WHY_ROUTES),
    },
    {
        path: 's3-config',
        loadChildren: () => import('./features/s3-config/s3-config.routes.js').then((m) => m.S3_CONFIG_ROUTES),
    },
    {
        path: 's4-debt',
        loadChildren: () => import('./features/s4-debt/s4-debt.routes.js').then((m) => m.S4_DEBT_ROUTES),
    },
    {
        path: 's5-artefact',
        loadChildren: () => import('./features/s5-artefact/s5-artefact.routes.js').then((m) => m.S5_ARTEFACT_ROUTES),
    },
];
