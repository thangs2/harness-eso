import { inject } from '@angular/core';
import { AuthService } from '../auth/auth.service.js';

export interface HttpRequestLike {
    headers: Record<string, string>;
    url: string;
    method: string;
}

/**
 * Functional HTTP Interceptor (Angular 22)
 * SKILL.md §4: Interceptors attach auth token, correlation/traceId, error normalization.
 */
export function createApiRequest(req: HttpRequestLike): HttpRequestLike {
    const authService = inject(AuthService);
    const headers = { ...req.headers };

    const token = authService.token();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    if (!headers['X-Trace-Id']) {
        headers['X-Trace-Id'] = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    return {
        ...req,
        headers,
    };
}
