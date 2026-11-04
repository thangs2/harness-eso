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
                    <a routerLink="/s1-work" routerLinkActive="active" class="nav-link">S1 Work</a>
                    <a routerLink="/s2-why" routerLinkActive="active" class="nav-link">S2 Why</a>
                    <a routerLink="/s3-config" routerLinkActive="active" class="nav-link">S3 Config</a>
                    <a routerLink="/s4-debt" routerLinkActive="active" class="nav-link">S4 Debt</a>
                    <a routerLink="/s5-artefact" routerLinkActive="active" class="nav-link">S5 Artefact</a>
                </nav>
            </header>
            <main class="eso-content" role="main">
                <router-outlet></router-outlet>
            </main>
        </div>
    `,
})
export class ShellComponent {}
