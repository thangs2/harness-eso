import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import { S1WorkTableComponent } from '../components/s1-work-table.component.js';
import { S1WorkStore } from '../state/s1-work.store.js';
import { S1WorkService } from '../data/s1-work.service.js';

/**
 * Routed Smart Component: S1 Work Page (SKILL.md §1.2 & §2)
 * Orchestrates page state and actions.
 * NEVER calls HttpClient directly.
 */
@Component({
    selector: 'eso-s1-work-page',
    standalone: true,
    imports: [StateFrameComponent, S1WorkTableComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s1-page-container">
            <header class="page-header">
                <h1>Dự án: {{ store.project() }}</h1>
            </header>

            <eso-state-frame
                [state]="store.state()"
                [errorMessage]="store.errorMessage()"
                emptyMessage="chưa có turn nào"
                (retry)="onReload()"
                (action)="onFrameAction($event)"
            >
                <eso-s1-work-table
                    [items]="store.items()"
                    (whyTriggered)="onWhyTriggered($event)"
                ></eso-s1-work-table>
            </eso-state-frame>
        </div>
    `,
})
export class S1WorkPage implements OnInit {
    readonly store = inject(S1WorkStore);
    private readonly service = inject(S1WorkService);
    private readonly router = inject(Router, { optional: true });

    ngOnInit(): void {
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
            void this.router.navigate(['/s2-why', turnId]);
        }
    }
}
