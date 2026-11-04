import type { Routes } from '@angular/router';

export const DIAGNOSIS_ROUTES: Routes = [
    {
        path: ':turnId',
        loadComponent: () => import('./pages/diagnosis.page.js').then((m) => m.DiagnosisPage),
    },
    {
        path: '',
        loadComponent: () => import('./pages/diagnosis.page.js').then((m) => m.DiagnosisPage),
    },
];
