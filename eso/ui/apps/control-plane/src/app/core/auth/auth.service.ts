import { Injectable, signal, computed } from '@angular/core';

/**
 * Authentication Service (Angular 22 Signals)
 * Security rule (SKILL.md §7): Bearer tokens stored in memory ONLY.
 * NEVER persist tokens in localStorage or sessionStorage.
 */
@Injectable({
    providedIn: 'root',
})
export class AuthService {
    private readonly _token = signal<string | null>(null);

    readonly token = this._token.asReadonly();
    readonly isAuthenticated = computed(() => this._token() !== null);

    setToken(token: string | null): void {
        this._token.set(token);
    }

    clearToken(): void {
        this._token.set(null);
    }
}
