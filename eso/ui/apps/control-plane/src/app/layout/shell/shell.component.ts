import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
    selector: 'eso-shell',
    standalone: true,
    imports: [RouterOutlet, RouterLink, RouterLinkActive],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="eso-layout">
            <header class="eso-header" role="banner">
                <div class="logo">ESO Control Plane</div>
                <nav class="eso-nav" aria-label="Main Navigation">
                    <a routerLink="/consumers" routerLinkActive="active" class="nav-link">Consumers</a>
                    <a routerLink="/onboarding" routerLinkActive="active" class="nav-link">Setup</a>
                    <a routerLink="/work-overview" routerLinkActive="active" class="nav-link">Work overview</a>
                    <a routerLink="/diagnosis" routerLinkActive="active" class="nav-link">Diagnosis</a>
                    <a routerLink="/declaration" routerLinkActive="active" class="nav-link">Declaration</a>
                    <a routerLink="/risk" routerLinkActive="active" class="nav-link">Risk</a>
                    <a routerLink="/audit" routerLinkActive="active" class="nav-link">Audit</a>
                </nav>
            </header>
            <main class="eso-content" role="main">
                <router-outlet></router-outlet>
            </main>
        </div>
    `,
})
export class ShellComponent {}
