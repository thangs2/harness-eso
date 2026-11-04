import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import type { RiskItem } from '../models/risk.model.js';

@Component({
    selector: 'eso-risk-page',
    standalone: true,
    imports: [StateFrameComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s4-page-container">
            <header class="page-header">
                <h1>Nợ kỹ thuật & Kiến trúc (S4 Debt)</h1>
            </header>

            <eso-state-frame
                [state]="items().length === 0 ? 'ST1_EMPTY' : 'READY'"
                emptyMessage="Không có nợ kỹ thuật nào được ghi nhận"
            >
                <ul class="debt-list">
                    @for (item of items(); track item.id) {
                        <li class="debt-item severity-{{ item.severity }}">
                            <span class="severity-badge">{{ item.severity }}</span>
                            <span class="description">{{ item.description }}</span>
                        </li>
                    }
                </ul>
            </eso-state-frame>
        </div>
    `,
})
export class RiskPage {
    readonly items = signal<RiskItem[]>([]);
}
