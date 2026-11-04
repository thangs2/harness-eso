import type { Routes } from '@angular/router';

export const S1_WORK_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/s1-work.page.js').then((m) => m.S1WorkPage),
    },
];
