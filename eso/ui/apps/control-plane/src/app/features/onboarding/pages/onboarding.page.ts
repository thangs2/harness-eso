import { Component, ChangeDetectionStrategy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OnboardingStore } from '../state/onboarding.store.js';
import { ConsumerProfileService } from '../../../core/consumers/consumer-profile.service.js';
import { GATES, HOST_PROFILES, PROFILE_RECIPES, ROLES, SOURCES } from '../models/onboarding.model.js';
import type { ConsumerPlan } from '../../../../../../../libs/api-client/types.js';

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
                        <span>{{ n === 1 ? 'Profile' : n === 2 ? 'Consumer' : n === 3 ? 'Integration' : 'Preview' }}</span>
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
                    @if (selectedRecipe(); as recipe) {
                        <div class="recipe-detail">
                            <div><h3>{{ recipe.name }} · nguồn bằng chứng</h3><p>{{ recipe.sources }}</p></div>
                            <div><strong>Yêu cầu</strong><p>{{ recipe.requires }}</p></div>
                            <div><strong>Phù hợp</strong><p>{{ recipe.bestFor }}</p></div>
                        </div>
                    }
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
                    <h2>3 · Integration</h2>
                    <p class="section-hint">Knowledge base, team, gate và adapter áp cho consumer này.</p>
                    <h3>Runtime</h3>
                    <div class="form-grid">
                        <label>JEV mode
                            <select [ngModel]="store.profile().integration.jevMode" (ngModelChange)="store.patchIntegration({ jevMode: $event })">
                                <option value="off">off</option><option value="flash">flash</option><option value="pro">pro</option>
                            </select>
                        </label>
                        <label>Host pack
                            <select [ngModel]="store.profile().integration.hostPack" (ngModelChange)="store.patchIntegration({ hostPack: $event })">
                                <option value="full">full</option><option value="lite">lite</option>
                            </select>
                        </label>
                        <label>Memory adapter
                            <select [ngModel]="store.profile().integration.memoryAdapter" (ngModelChange)="store.patchIntegration({ memoryAdapter: $event })">
                                <option value="none">none</option><option value="agentmemory">agentmemory</option><option value="native">native</option>
                            </select>
                        </label>
                        <label class="check"><input type="checkbox" [checked]="store.profile().integration.consent" (change)="store.patchIntegration({ consent: !store.profile().integration.consent })"> Cho phép ghi evidence / consent</label>
                    </div>
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
                    <h2>4 · Preview</h2>
                    <p class="section-hint">Đây là plan sẽ được ghi khi consumer được áp dụng. Chưa có file nào bị thay đổi.</p>
                    @if (planning()) {
                        <p class="loading-label">Đang tạo plan…</p>
                    } @else if (plan(); as p) {
                        <div class="plan-head">
                            <span>Root: <code>{{ p.root }}</code></span>
                            <span>{{ p.files.length }} file · {{ p.warnings.length }} cảnh báo</span>
                        </div>
                        @if (p.warnings.length) {
                            <ul class="warn-list">
                                @for (warning of p.warnings; track warning) { <li>{{ warning }}</li> }
                            </ul>
                        }
                        <div class="plan-files">
                            @for (file of p.files; track file.relative) {
                                <details class="plan-file">
                                    <summary><code>{{ file.relative }}</code><span class="action-badge">{{ file.action }}</span></summary>
                                    <pre>{{ file.preview | json }}</pre>
                                </details>
                            }
                        </div>
                        <label class="check confirm-line">
                            <input type="checkbox" [checked]="confirmed()" (change)="confirmed.set(!confirmed())">
                            Tôi đã xem plan và xác nhận đăng ký consumer này.
                        </label>
                    } @else if (planError(); as message) {
                        <p class="form-error" role="alert">{{ message }}</p>
                        <button type="button" class="btn-ghost" (click)="loadPlan()">Thử lại</button>
                    }
                }

                <div class="actions-row">
                    <button type="button" class="btn-ghost" [disabled]="store.step() === 1" (click)="store.back()">Quay lại</button>
                    @if (store.step() < 4) {
                        <button type="button" class="btn-primary" (click)="next()">Tiếp</button>
                    } @else {
                        <button type="button" class="btn-primary" [disabled]="store.saving() || !confirmed()" (click)="save()">
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
    readonly selectedRecipe = computed(
        () => this.recipes.find((recipe) => recipe.id === this.store.profile().profile.recipe) || this.recipes[1]
    );
    readonly plan = signal<ConsumerPlan | null>(null);
    readonly planning = signal(false);
    readonly planError = signal<string | null>(null);
    readonly confirmed = signal(false);
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

    next(): void {
        const before = this.store.step();
        if (!this.store.next()) return;
        if (before < 4 && this.store.step() === 4) void this.loadPlan();
    }

    async loadPlan(): Promise<void> {
        this.planning.set(true);
        this.planError.set(null);
        try {
            this.plan.set(await this.service.plan(this.store.profile()));
        } catch (error: any) {
            this.planError.set(error?.detail || error?.message || 'Không tạo được plan');
        } finally {
            this.planning.set(false);
        }
    }

    async save(): Promise<void> {
        if (!this.plan()) await this.loadPlan();
        if (!this.plan()) return;
        if (!this.confirmed()) {
            this.store.error.set('Xem plan và tick xác nhận trước khi lưu.');
            return;
        }
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
