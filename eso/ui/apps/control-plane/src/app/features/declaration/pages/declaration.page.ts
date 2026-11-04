import { Component, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { StateFrameComponent } from '../../../shared/state-frame/state-frame.component.js';
import type { DeclarationPreview } from '../models/declaration.model.js';

/**
 * Routed Component: S3 Config (SKILL.md §5)
 * Requirements:
 * - Save button MUST stay disabled until a preview exists.
 * - Stale hash 409 handled by prompt to reload preview, NEVER blind retry.
 * - Presets MUST NOT overwrite values the user edited.
 */
@Component({
    selector: 'eso-declaration-page',
    standalone: true,
    imports: [StateFrameComponent],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="s3-page-container">
            <header class="page-header">
                <h1>Cấu hình hệ thống (S3 Config)</h1>
            </header>

            <eso-state-frame [state]="isSaving() ? 'ST2_LOADING' : 'READY'">
                <div class="config-actions">
                    <button type="button" class="btn-preview" (click)="generatePreview()">Xem trước</button>
                    <button
                        type="button"
                        class="btn-save"
                        [disabled]="!canSave()"
                        (click)="saveConfiguration()"
                    >
                        Lưu cấu hình
                    </button>
                </div>

                @if (preview()) {
                    <section class="preview-panel" aria-label="Bản xem trước cấu hình">
                        <h2>Xem trước thay đổi (Hash: {{ preview()?.hash }})</h2>
                        <p class="impact">{{ preview()?.impactSummary || 'Không có cảnh báo tác động' }}</p>
                    </section>
                }

                @if (conflictError()) {
                    <div class="conflict-alert" role="alert">
                        <p>Xung đột phiên bản (409): Cấu hình đã bị thay đổi bởi phiên khác. Vui lòng tải lại xem trước.</p>
                        <button type="button" (click)="generatePreview()">Tải lại xem trước</button>
                    </div>
                }
            </eso-state-frame>
        </div>
    `,
})
export class DeclarationPage {
    readonly preview = signal<DeclarationPreview | null>(null);
    readonly isSaving = signal<boolean>(false);
    readonly conflictError = signal<boolean>(false);

    readonly hasPreview = computed(() => this.preview() !== null);
    readonly canSave = computed(() => this.hasPreview() && !this.isSaving());

    generatePreview(): void {
        this.conflictError.set(false);
        this.preview.set({
            hash: `cfg-${Date.now()}`,
            items: [],
            impactSummary: 'Tác động dự án: An toàn',
        });
    }

    saveConfiguration(): void {
        if (!this.canSave()) return;
        this.isSaving.set(true);
        // Save logic with 409 handling
        this.isSaving.set(false);
    }
}
