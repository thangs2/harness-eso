import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { ShellComponent } from '../apps/control-plane/src/app/layout/shell/shell.component.js';
import { APP_ROUTES } from '../apps/control-plane/src/app/routes.js';

bootstrapApplication(ShellComponent, {
  providers: [
    provideRouter(APP_ROUTES),
  ],
}).catch((err: unknown) => console.error(err));
