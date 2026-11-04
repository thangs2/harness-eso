import type { Routes } from '@angular/router';

export const RISK_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/risk.page.js').then((m) => m.RiskPage),
    },
];
