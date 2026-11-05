import { Injectable, signal } from '@angular/core';
import { DEFAULT_PROFILE, type ConsumerProfile } from '../models/onboarding.model.js';

@Injectable({ providedIn: 'root' })
export class OnboardingStore {
    readonly step = signal(1);
    readonly totalSteps = 4;
    readonly profile = signal<ConsumerProfile>(structuredClone(DEFAULT_PROFILE));
    readonly protectedPathsText = signal(DEFAULT_PROFILE.protectedPaths.join('\n'));
    readonly saving = signal(false);
    readonly error = signal<string | null>(null);
    readonly savedId = signal<string | null>(null);

    reset(): void {
        this.step.set(1);
        this.profile.set(structuredClone(DEFAULT_PROFILE));
        this.protectedPathsText.set(DEFAULT_PROFILE.protectedPaths.join('\n'));
        this.error.set(null);
        this.savedId.set(null);
        this.saving.set(false);
    }

    setProfile(profile: ConsumerProfile): void {
        this.profile.set(profile);
        this.protectedPathsText.set((profile.protectedPaths || []).join('\n'));
    }

    patch(partial: Partial<ConsumerProfile>): void {
        this.profile.set({ ...this.profile(), ...partial });
    }

    patchZone(index: number, field: 'path' | 'headerProfile', value: string): void {
        const zones = this.profile().zones.map((zone, i) => (i === index ? { ...zone, [field]: value } : zone));
        this.patch({ zones });
    }

    patchIntegration(partial: Partial<{ jevMode: string; consent: boolean; hostPack: string; memoryAdapter: string }>): void {
        this.patch({ integration: { ...this.profile().integration, ...partial } });
    }

    selectRecipe(recipe: string): void {
        const sources =
            recipe === 'lite'
                ? { docgraph: false, codegraph: false, memory: false }
                : recipe === 'dsh-native'
                  ? { docgraph: true, codegraph: true, memory: true }
                  : { docgraph: true, codegraph: true, memory: true };
        this.patch({
            profile: { ...this.profile().profile, recipe, description: recipe },
            sources,
        });
    }

    toggleRole(role: string): void {
        const roles = this.profile().team.roles;
        const next = roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role];
        this.patch({ team: { ...this.profile().team, roles: next } });
    }

    toggleGate(gate: string): void {
        const gates = { ...this.profile().gates, [gate]: !this.profile().gates[gate] };
        this.patch({ gates });
    }

    toggleSource(source: string): void {
        const sources = { ...this.profile().sources, [source]: !this.profile().sources[source] };
        this.patch({ sources });
    }

    toggleTool(tool: string): void {
        const tools = { ...this.profile().tools, [tool]: !this.profile().tools[tool] };
        this.patch({ tools });
    }

    setProtectedPaths(text: string): void {
        this.protectedPathsText.set(text);
        this.patch({
            protectedPaths: text
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
        });
    }

    validateStep(): string | null {
        const p = this.profile();
        if (this.step() === 1) {
            if (!p.profile?.recipe) return 'Chọn một profile recipe.';
            if (!p.profile?.hostProfile) return 'Chọn host profile.';
        }
        if (this.step() === 2) {
            if (!/^[a-z][a-z0-9-]{1,31}$/.test(p.id)) return 'Consumer id phải là slug thường (2–32 ký tự).';
            if (!p.name.trim()) return 'Tên consumer là bắt buộc.';
            if (!p.root.trim()) return 'Đường dẫn repo là bắt buộc.';
        }
        if (this.step() === 3) {
            if (!p.sdlcRoot.trim()) return 'SDLC root là bắt buộc.';
            if (p.zones.some((zone) => !zone.path.trim())) return 'Mỗi zone phải có path.';
            if (p.team.roles.length === 0) return 'Chọn ít nhất một role.';
        }
        return null;
    }

    next(): boolean {
        const error = this.validateStep();
        if (error) {
            this.error.set(error);
            return false;
        }
        this.error.set(null);
        this.step.set(Math.min(this.totalSteps, this.step() + 1));
        return true;
    }

    back(): void {
        this.error.set(null);
        this.step.set(Math.max(1, this.step() - 1));
    }
}
