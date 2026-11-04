import type { Routes } from '@angular/router';

export const S3_CONFIG_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('./pages/s3-config.page.js').then((m) => m.S3ConfigPage),
    },
];
