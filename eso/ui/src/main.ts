import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { ShellComponent } from '../apps/control-plane/src/app/layout/shell/shell.component.js';
import { APP_ROUTES } from '../apps/control-plane/src/app/routes.js';
import { APP_CONFIG, CONTROL_PLANE_API_CLIENT } from '../apps/control-plane/src/app/core/tokens.js';
import { ControlPlaneApiClient } from '../libs/api-client/client.js';

const API_BASE = 'http://127.0.0.1:8787';
const DEMO_TOKEN = 'demo-token';

bootstrapApplication(ShellComponent, {
    providers: [
        provideRouter(APP_ROUTES),
        { provide: APP_CONFIG, useValue: { apiBaseUrl: API_BASE, environment: 'development' } },
        {
            provide: CONTROL_PLANE_API_CLIENT,
            useFactory: () =>
                new ControlPlaneApiClient({
                    baseUrl: API_BASE,
                    // Demo-only token; the real shell will read it from the auth service.
                    tokenProvider: () => globalThis.localStorage?.getItem('eso.token') ?? DEMO_TOKEN,
                }),
        },
    ],
}).catch((err: unknown) => console.error(err));
