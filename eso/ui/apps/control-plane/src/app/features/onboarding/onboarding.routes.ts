import type { Routes } from '@angular/router';
import { OnboardingPage } from './pages/onboarding.page.js';

export const ONBOARDING_ROUTES: Routes = [
    { path: '', component: OnboardingPage },
    { path: ':id', component: OnboardingPage },
];
