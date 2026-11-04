import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import type { DiagnosisEvidence } from '../models/diagnosis.model.js';

/**
 * Routed Component: S2 Why (SKILL.md §5)
 * Read-only surface: MUST NOT render any write controls.
 */
@Component({
    selector: 'eso-diagnosis-page',
    standalone: true,
    imports: [StateFrameComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s2-page-container">
            <header class="page-header">
                <h1>Giải trình quyết định (S2 Why)</h1>
            </header>

            <eso-state-frame [state]="evidence() ? 'READY' : 'ST1_EMPTY'" emptyMessage="Chưa có bằng chứng cho lượt chạy này">
                @if (evidence()) {
                    <article class="evidence-card">
                        <h2>Quyết định: {{ evidence()?.decision }}</h2>
                        <p class="actor">Tác nhân: {{ evidence()?.actor }}</p>
                        <p class="rationale">Lý do: {{ evidence()?.rationale }}</p>
                    </article>
                }
            </eso-state-frame>
        </div>
    `,
})
export class DiagnosisPage {
    readonly evidence = input<DiagnosisEvidence | null>(null);
}
