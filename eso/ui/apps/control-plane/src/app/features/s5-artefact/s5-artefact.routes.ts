import type { Routes } from '@angular/router';

export const S5_ARTEFACT_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/s5-artefact.page.js').then((m) => m.S5ArtefactPage),
    },
];
