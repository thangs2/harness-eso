import { Injectable, signal, computed } from '@angular/core';
import type { UXState } from '../../../shared/state-frame/state-frame.component.js';
import type { WorkOverviewItem } from '../models/work-overview.model.js';

/**
 * Signal Store for S1 Work Overview (SKILL.md §1.2 & §3)
 * Pure state container: NEVER calls HTTP directly.
 */
@Injectable({
    providedIn: 'root',
})
export class WorkOverviewStore {
    readonly state = signal<UXState>('ST2_LOADING');
    readonly project = signal<string>('default');
    readonly items = signal<WorkOverviewItem[]>([]);
    readonly errorMessage = signal<string | null>(null);
    readonly selectedTurnId = signal<string | null>(null);

    readonly totalItems = computed(() => this.items().length);
    readonly hasItems = computed(() => this.items().length > 0);
    readonly isReadOnly = computed(() => true); // S1 is strictly read-only per D-72

    setProject(name: string): void {
        this.project.set(name);
    }

    setLoading(): void {
        this.state.set('ST2_LOADING');
        this.errorMessage.set(null);
    }

    setFailed(error: string): void {
        this.state.set('ST3_FAILED');
        this.errorMessage.set(error);
    }

    setDenied(): void {
        this.state.set('ST4_DENIED');
        this.errorMessage.set(null);
    }

    setLoaded(items: WorkOverviewItem[]): void {
        this.items.set(items);
        this.errorMessage.set(null);
        if (items.length === 0) {
            this.state.set('ST1_EMPTY');
        } else {
            // ST6 is stale only; a list with content is READY.
            this.state.set('READY');
        }
    }

    selectTurn(turnId: string | null): void {
        this.selectedTurnId.set(turnId);
    }
}
