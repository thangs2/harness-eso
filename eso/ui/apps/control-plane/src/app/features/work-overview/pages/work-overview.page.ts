import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import { WorkOverviewTableComponent } from '../components/work-overview-table.component.js';
import { WorkOverviewStore } from '../state/work-overview.store.js';
import { WorkOverviewService } from '../data/work-overview.service.js';

/**
 * Routed Smart Component: S1 Work Page (SKILL.md §1.2 & §2)
 * Orchestrates page state and actions.
 * NEVER calls HttpClient directly.
 */
@Component({
    selector: 'eso-work-overview-page',
    standalone: true,
    imports: [StateFrameComponent, WorkOverviewTableComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s1-page-container">
            <header class="page-header">
                <div>
                    <p class="eyebrow">ESO Control Plane</p>
                    <h1>Work overview</h1>
                    <p class="subtitle">Dự án: {{ store.project() }} · {{ store.totalItems() }} turn</p>
                </div>
                <span class="readonly-badge">Chỉ đọc</span>
            </header>

            <eso-state-frame
                [state]="store.state()"
                [errorMessage]="store.errorMessage()"
                emptyMessage="chưa có turn nào"
                (retry)="onReload()"
                (action)="onFrameAction($event)"
            >
                <eso-work-overview-table
                    [items]="store.items()"
                    (whyTriggered)="onWhyTriggered($event)"
                ></eso-work-overview-table>
            </eso-state-frame>
        </div>
    `,
})
export class WorkOverviewPage implements OnInit {
    readonly store = inject(WorkOverviewStore);
    private readonly service = inject(WorkOverviewService);
    private readonly router = inject(Router, { optional: true });
    private readonly route = inject(ActivatedRoute, { optional: true });

    ngOnInit(): void {
        const project = this.route?.snapshot.queryParamMap.get('project');
        if (project) this.store.setProject(project);
        void this.loadData();
    }

    async loadData(): Promise<void> {
        this.store.setLoading();
        try {
            const items = await this.service.loadWork(this.store.project());
            this.store.setLoaded(items);
        } catch (err: unknown) {
            const errorObj = err as { status?: number; detail?: string; message?: string };
            if (errorObj?.status === 403 || errorObj?.status === 404) {
                this.store.setDenied();
            } else {
                this.store.setFailed(errorObj?.detail || errorObj?.message || 'Không thể nạp dữ liệu');
            }
        }
    }

    onReload(): void {
        void this.loadData();
    }

    onFrameAction(action: string): void {
        if (action === 'CHANGE_PROJECT' && this.router) {
            void this.router.navigate(['/projects']);
        }
    }

    onWhyTriggered(turnId: string): void {
        this.store.selectTurn(turnId);
        if (this.router) {
            void this.router.navigate(['/diagnosis', turnId]);
        }
    }
}
