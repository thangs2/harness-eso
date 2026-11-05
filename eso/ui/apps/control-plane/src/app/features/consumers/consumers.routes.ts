import type { Routes } from '@angular/router';
import { ConsumersPage } from './pages/consumers.page.js';
import { ConsumerDetailPage } from './pages/consumer-detail.page.js';

export const CONSUMERS_ROUTES: Routes = [
    { path: '', component: ConsumersPage },
    { path: ':id', component: ConsumerDetailPage },
];
