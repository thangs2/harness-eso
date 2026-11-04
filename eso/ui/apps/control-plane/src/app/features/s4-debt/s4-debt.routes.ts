import type { Routes } from '@angular/router';

export const S4_DEBT_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/s4-debt.page.js').then((m) => m.S4DebtPage),
    },
];
