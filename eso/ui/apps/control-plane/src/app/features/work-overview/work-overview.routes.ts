import type { Routes } from '@angular/router';

export const WORK_OVERVIEW_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/work-overview.page.js').then((m) => m.WorkOverviewPage),
    },
];
