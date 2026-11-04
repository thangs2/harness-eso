import { Injectable, signal, inject } from '@angular/core';
import { APP_CONFIG, type AppConfig } from '../tokens.js';

@Injectable({
    providedIn: 'root',
})
export class AppConfigService {
    private readonly initialConfig = inject(APP_CONFIG, { optional: true }) || {
        apiBaseUrl: 'http://127.0.0.1:8792',
        environment: 'development' as const,
    };

    readonly apiBaseUrl = signal<string>(this.initialConfig.apiBaseUrl);
    readonly environment = signal<'development' | 'production' | 'test'>(this.initialConfig.environment);

    setApiBaseUrl(url: string): void {
        this.apiBaseUrl.set(url.replace(/\/$/, ''));
    }
}
