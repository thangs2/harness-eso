import type { Routes } from '@angular/router';

export const AUDIT_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/audit.page.js').then((m) => m.AuditPage),
    },
];
