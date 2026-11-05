import { Component, ChangeDetectionStrategy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OnboardingStore } from '../state/onboarding.store.js';
import { ConsumerProfileService } from '../data/consumer-profile.service.js';
import { GATES, HOST_PROFILES, PROFILE_RECIPES, ROLES, SOURCES } from '../models/onboarding.model.js';

@Component({
    selector: 'eso-onboarding-page',
    standalone: true,
    imports: [FormsModule, JsonPipe, RouterLink],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="onboarding">
            <header class="page-header">
                <div>
                    <p class="eyebrow">Control Plane · Setup</p>
                    <h1>Đăng ký profile & consumer</h1>
                    <p class="subtitle">Chọn profile trước, gắn với một consumer cụ thể, rồi mới xử lý case-by-case.</p>
                </div>
                <a class="btn-ghost" routerLink="/consumers">Danh sách consumer</a>
            </header>

            <nav class="stepper" aria-label="Các bước thiết lập">
                @for (n of [1, 2, 3, 4]; track n) {
                    <div class="step" [class.active]="store.step() === n" [class.done]="store.step() > n">
                        <span class="step-no">{{ n }}</span>
                        <span>{{ n === 1 ? 'Profile' : n === 2 ? 'Consumer' : n === 3 ? 'Configuration' : 'Review' }}</span>
                    </div>
                }
            </nav>

            @if (store.error(); as error) {
                <p class="form-error" role="alert">{{ error }}</p>
            }

            <section class="panel">
                @if (store.step() === 1) {
                    <h2>1 · Profile</h2>
                    <p class="section-hint">Profile quyết định nguồn bằng chứng và host runtime. Chọn một recipe rồi tinh chỉnh ở bước cấu hình.</p>
                    <div class="profile-cards">
                        @for (recipe of recipes; track recipe.id) {
                            <button
                                type="button"
                                class="profile-card"
                                [class.selected]="store.profile().profile.recipe === recipe.id"
                                (click)="store.selectRecipe(recipe.id)"
                            >
                                <span class="profile-head"><strong>{{ recipe.name }}</strong><span class="profile-check">✓</span></span>
                                <span class="profile-desc">{{ recipe.description }}</span>
                            </button>
                        }
                    </div>
                    <div class="form-grid">
                        <label>Host profile
                            <select [ngModel]="store.profile().profile.hostProfile" (ngModelChange)="store.patch({ profile: { ...store.profile().profile, hostProfile: $event } })">
                                @for (host of hosts; track host) {
                                    <option [value]="host">{{ host }}</option>
                                }
                            </select>
                        </label>
                        <label>Mô tả profile
                            <input [ngModel]="store.profile().profile.description || ''" (ngModelChange)="store.patch({ profile: { ...store.profile().profile, description: $event } })" placeholder="Vì sao consumer này dùng profile này">
                        </label>
                    </div>
                }

                @if (store.step() === 2) {
                    <h2>2 · Consumer</h2>
                    <p class="section-hint">Thông tin định danh của repo sẽ dùng profile ở trên.</p>
                    <div class="form-grid">
                        <label>Consumer ID
                            <input [ngModel]="store.profile().id" (ngModelChange)="store.patch({ id: $event })" placeholder="baplatform" autocomplete="off">
                            <small>Slug thường, dùng làm project key.</small>
                        </label>
                        <label>Tên hiển thị
                            <input [ngModel]="store.profile().name" (ngModelChange)="store.patch({ name: $event })" placeholder="Ba Platform">
                        </label>
                        <label>Đường dẫn repo
                            <input [ngModel]="store.profile().root" (ngModelChange)="store.patch({ root: $event })" placeholder="/Users/.../baplatform">
                        </label>
                        <label>Repo URL
                            <input [ngModel]="store.profile().repoUrl" (ngModelChange)="store.patch({ repoUrl: $event })" placeholder="git@...">
                        </label>
                        <label>Host mode
                            <select [ngModel]="store.profile().hostMode" (ngModelChange)="store.patch({ hostMode: $event })">
                                <option value="dual-ide">dual-ide</option>
                                <option value="superset">superset</option>
                            </select>
                        </label>
                        <label>Observe port
                            <input type="number" [ngModel]="store.profile().observePort" (ngModelChange)="store.patch({ observePort: +$event })">
                        </label>
                    </div>
                }

                @if (store.step() === 3) {
                    <h2>3 · Configuration</h2>
                    <p class="section-hint">Cấu trúc knowledge base, team và gate áp cho consumer này.</p>
                    <div class="form-grid">
                        <label>SDLC root
                            <input [ngModel]="store.profile().sdlcRoot" (ngModelChange)="store.patch({ sdlcRoot: $event })" placeholder="sdlc">
                        </label>
                        <label>Header profile
                            <input [ngModel]="store.profile().headerProfile" (ngModelChange)="store.patch({ headerProfile: $event })" placeholder="standard-v1">
                        </label>
                        <label>Preset version
                            <input [ngModel]="store.profile().presetVersion" (ngModelChange)="store.patch({ presetVersion: $event })" placeholder="2026-11">
                        </label>
                    </div>
                    <h3>Zones</h3>
                    @for (zone of store.profile().zones; track zone.name; let i = $index) {
                        <div class="zone-row">
                            <strong>{{ zone.name }}</strong>
                            <input [ngModel]="zone.path" (ngModelChange)="store.patchZone(i, 'path', $event)" placeholder="đường dẫn">
                            <input [ngModel]="zone.headerProfile || ''" (ngModelChange)="store.patchZone(i, 'headerProfile', $event)" placeholder="header profile">
                        </div>
                    }
                    <h3>Tools</h3>
                    <div class="check-row">
                        @for (tool of ['jira', 'notion', 'plan']; track tool) {
                            <label class="check"><input type="checkbox" [checked]="store.profile().tools[tool]" (change)="store.toggleTool(tool)"> {{ tool }}</label>
                        }
                    </div>
                    <h3>Roles</h3>
                    <div class="check-row">
                        @for (role of roles; track role) {
                            <label class="check"><input type="checkbox" [checked]="store.profile().team.roles.includes(role)" (change)="store.toggleRole(role)"> {{ role }}</label>
                        }
                    </div>
                    <h3>Gates</h3>
                    <div class="check-row">
                        @for (gate of gates; track gate) {
                            <label class="check"><input type="checkbox" [checked]="store.profile().gates[gate]" (change)="store.toggleGate(gate)"> {{ gate }}</label>
                        }
                    </div>
                    <h3>Evidence sources</h3>
                    <div class="check-row">
                        @for (source of sources; track source) {
                            <label class="check"><input type="checkbox" [checked]="store.profile().sources[source]" (change)="store.toggleSource(source)"> {{ source }}</label>
                        }
                    </div>
                    <label class="full">Protected paths (mỗi dòng một path)
                        <textarea rows="6" [ngModel]="store.protectedPathsText()" (ngModelChange)="store.setProtectedPaths($event)"></textarea>
                    </label>
                }

                @if (store.step() === 4) {
                    <h2>4 · Review</h2>
                    <dl class="review-grid">
                        <dt>Profile</dt><dd>{{ store.profile().profile.recipe }} · {{ store.profile().profile.hostProfile }}</dd>
                        <dt>Consumer</dt><dd>{{ store.profile().id }} — {{ store.profile().name }}</dd>
                        <dt>Repo</dt><dd>{{ store.profile().root }}</dd>
                        <dt>SDLC root</dt><dd>{{ store.profile().sdlcRoot }}</dd>
                        <dt>Roles</dt><dd>{{ store.profile().team.roles.join(', ') }}</dd>
                        <dt>Protected paths</dt><dd>{{ store.profile().protectedPaths.length }} path</dd>
                    </dl>
                    <details>
                        <summary>Profile JSON</summary>
                        <pre>{{ store.profile() | json }}</pre>
                    </details>
                }

                <div class="actions-row">
                    <button type="button" class="btn-ghost" [disabled]="store.step() === 1" (click)="store.back()">Quay lại</button>
                    @if (store.step() < 4) {
                        <button type="button" class="btn-primary" (click)="store.next()">Tiếp</button>
                    } @else {
                        <button type="button" class="btn-primary" [disabled]="store.saving()" (click)="save()">
                            {{ store.saving() ? 'Đang lưu…' : 'Lưu consumer' }}
                        </button>
                    }
                </div>
            </section>
        </div>
    `,
})
export class OnboardingPage implements OnInit {
    readonly store = inject(OnboardingStore);
    private readonly service = inject(ConsumerProfileService);
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    readonly roles = ROLES;
    readonly gates = GATES;
    readonly sources = SOURCES;
    readonly recipes = PROFILE_RECIPES;
    readonly hosts = HOST_PROFILES;
    private editingId: string | null = null;

    ngOnInit(): void {
        this.editingId = this.route.snapshot.paramMap.get('id');
        if (!this.editingId) {
            this.store.reset();
            return;
        }
        this.service
            .get(this.editingId)
            .then((profile) => this.store.setProfile(profile))
            .catch((error) => this.store.error.set(error?.detail || 'Không tải được profile'));
    }

    async save(): Promise<void> {
        const profile = this.store.profile();
        if (!profile.id || !profile.name || !profile.root) {
            this.store.error.set('Consumer id, tên và repo là bắt buộc.');
            return;
        }
        this.store.saving.set(true);
        this.store.error.set(null);
        try {
            const saved = this.editingId
                ? await this.service.update(this.editingId, profile)
                : await this.service.create(profile);
            this.store.savedId.set(saved.id);
            await this.router.navigate(['/consumers', saved.id], { queryParams: { created: '1' } });
        } catch (error: any) {
            this.store.error.set(error?.detail || error?.message || 'Lưu profile thất bại');
        } finally {
            this.store.saving.set(false);
        }
    }
}
