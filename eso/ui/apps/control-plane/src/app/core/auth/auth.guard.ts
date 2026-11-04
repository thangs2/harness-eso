import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { AuthService } from './auth.service.js';

/**
 * Functional Route Guard (Angular 22)
 * SKILL.md §7: Route guards are UX convenience, NOT authorization.
 * The API backend remains the single source of truth for authorization.
 */
export const authGuard: CanActivateFn = (_route, _state) => {
    const authService = inject(AuthService);
    const router = inject(Router);

    if (authService.isAuthenticated()) {
        return true;
    }

    return router.createUrlTree(['/login']);
};
