import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import type { AuditItem } from '../models/audit.model.js';

/**
 * Routed Component: S5 Artefact (SKILL.md §5)
 * Read-only surface: MUST NOT render any write controls.
 */
@Component({
    selector: 'eso-audit-page',
    standalone: true,
    imports: [StateFrameComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s5-page-container">
            <header class="page-header">
                <h1>Kho lưu trữ Hiện vật (S5 Artefact)</h1>
            </header>

            <eso-state-frame
                [state]="items().length === 0 ? 'ST1_EMPTY' : 'READY'"
                emptyMessage="Chưa có hiện vật nào được lưu trữ"
            >
                <div class="artefact-grid">
                    @for (item of items(); track item.id) {
                        <div class="artefact-card">
                            <span class="artefact-name">{{ item.name }}</span>
                            <span class="artefact-meta">{{ item.type }} — {{ item.sizeBytes }} bytes</span>
                        </div>
                    }
                </div>
            </eso-state-frame>
        </div>
    `,
})
export class AuditPage {
    readonly items = signal<AuditItem[]>([]);
}
