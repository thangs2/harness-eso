import type { Routes } from '@angular/router';

export const S2_WHY_ROUTES: Routes = [
    {
        path: ':turnId',
        loadComponent: () => import('./pages/s2-why.page.js').then((m) => m.S2WhyPage),
    },
    {
        path: '',
        loadComponent: () => import('./pages/s2-why.page.js').then((m) => m.S2WhyPage),
    },
];
