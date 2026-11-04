import type { Routes } from '@angular/router';

export const DECLARATION_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/declaration.page.js').then((m) => m.DeclarationPage),
    },
];
