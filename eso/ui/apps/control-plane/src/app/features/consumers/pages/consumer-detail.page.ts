import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ConsumerProfileService } from '../../../core/consumers/consumer-profile.service.js';
import type { ConsumerProfile } from '../../../../../../../libs/api-client/types.js';

@Component({
    selector: 'eso-consumer-detail-page',
    standalone: true,
    imports: [RouterLink],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @if (profile(); as p) {
            <header class="page-header">
                <div>
                    <p class="eyebrow">Consumer · v{{ p.version || 1 }}</p>
                    <h1>{{ p.name }}</h1>
                    <p class="subtitle"><code>{{ p.id }}</code> · {{ p.root }}</p>
                </div>
                <div class="actions-row">
                    <a class="btn-ghost" [routerLink]="['/onboarding', p.id]">Sửa profile</a>
                    <a class="btn-primary" [routerLink]="['/work-overview']" [queryParams]="{ project: p.id }">Mở work overview</a>
                </div>
            </header>

            @if (created()) {
                <p class="saved-banner">Đã lưu consumer. Bước thiết lập hoàn tất; giờ có thể xử lý case-by-case.</p>
            }

            <div class="detail-grid">
                <section class="panel">
                    <h2>Profile</h2>
                    <dl class="kv">
                        <dt>Recipe</dt><dd>{{ p.profile?.recipe }}</dd>
                        <dt>Host profile</dt><dd>{{ p.profile?.hostProfile }}</dd>
                        <dt>Description</dt><dd>{{ p.profile?.description || '—' }}</dd>
                        <dt>Version</dt><dd>v{{ p.version }} · {{ p.status }}</dd>
                    </dl>
                </section>
                <section class="panel">
                    <h2>Knowledge base</h2>
                    <dl class="kv">
                        <dt>SDLC root</dt><dd>{{ p.sdlcRoot }}</dd>
                        <dt>Header profile</dt><dd>{{ p.headerProfile }}</dd>
                        <dt>Preset</dt><dd>{{ p.presetVersion || '—' }}</dd>
                        @for (zone of p.zones; track zone.name) {
                            <dt>Zone {{ zone.name }}</dt><dd>{{ zone.path }} · {{ zone.headerProfile || '—' }}</dd>
                        }
                    </dl>
                </section>
                <section class="panel">
                    <h2>Team & gates</h2>
                    <dl class="kv">
                        <dt>Roles</dt><dd>{{ p.team.roles.join(', ') }}</dd>
                        <dt>Gates</dt><dd>{{ enabled(p.gates) }}</dd>
                        <dt>Sources</dt><dd>{{ enabled(p.sources) }}</dd>
                    </dl>
                </section>
                <section class="panel">
                    <h2>Protected paths</h2>
                    @if (p.protectedPaths.length === 0) {
                        <p class="muted">Chưa khai path bảo vệ.</p>
                    } @else {
                        <ul class="path-list">
                            @for (path of p.protectedPaths; track path) { <li><code>{{ path }}</code></li> }
                        </ul>
                    }
                </section>
            </div>
        } @else if (error(); as message) {
            <p class="form-error" role="alert">{{ message }}</p>
        } @else {
            <section class="panel"><p class="loading-label">Đang nạp consumer…</p></section>
        }
    `,
})
export class ConsumerDetailPage implements OnInit {
    private readonly service = inject(ConsumerProfileService);
    private readonly route = inject(ActivatedRoute);
    readonly profile = signal<ConsumerProfile | null>(null);
    readonly error = signal<string | null>(null);
    readonly created = signal(false);

    ngOnInit(): void {
        const id = this.route.snapshot.paramMap.get('id')!;
        this.created.set(this.route.snapshot.queryParamMap.get('created') === '1');
        this.service
            .get(id)
            .then((profile) => this.profile.set(profile))
            .catch((err) => this.error.set(err?.detail || 'Không tải được consumer'));
    }

    enabled(map: Record<string, unknown>): string {
        const keys = Object.entries(map || {})
            .filter(([, value]) => value === true)
            .map(([key]) => key);
        return keys.length ? keys.join(', ') : '—';
    }
}
