/**
 * API Contract Types (Generated from Control Plane OpenAPI / RFC 9457)
 * NEVER hand-write DTOs in feature code.
 */

export interface WorkOverviewTurnDto {
    turn_id: string;
    work: string;
    level: 'sufficient' | 'partial' | 'missing' | 'none';
    missing_count: number;
    distinct_styling: string;
    timestamp?: string;
}

export interface WorkOverviewResponse {
    project: string;
    total: number;
    items: WorkOverviewTurnDto[];
}

export interface ConfigPreviewDto {
    config: Record<string, unknown>;
    hash: string;
    impactSummary?: string;
}

export interface ProblemDetailsDto {
    type?: string;
    title: string;
    status: number;
    detail?: string;
    instance?: string;
}

export interface ConsumerZone {
    name: 'human' | 'agent';
    path: string;
    headerProfile?: string;
}

export interface ConsumerProfile {
    id: string;
    name: string;
    root: string;
    repoUrl?: string;
    hostMode?: string;
    observePort?: number;
    sdlcRoot: string;
    profile: { recipe: string; hostProfile: string; description?: string };
    integration: { jevMode: string; consent: boolean; hostPack: string; memoryAdapter: string };
    zones: ConsumerZone[];
    headerProfile: string;
    presetVersion?: string;
    tools: Record<string, unknown>;
    team: { roles: string[]; presets?: string[] };
    gates: Record<string, unknown>;
    sources: Record<string, unknown>;
    protectedPaths: string[];
    // The detail endpoint returns the snapshot's own bookkeeping alongside the profile; the type must say so
    // or every consumer of it has to reach for a cast (D-72 bans casts that only silence the compiler).
    version?: number;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface ConsumerSummary {
    id: string;
    name: string;
    root: string;
    sdlcRoot: string;
    profile: { recipe: string; hostProfile: string; description?: string };
    integration: { jevMode: string; consent: boolean; hostPack: string; memoryAdapter: string };
    version: number;
    status: string;
    updatedAt: string;
}

export interface ConsumerListResponse {
    items: ConsumerSummary[];
}

export interface ConsumerPlanFile {
    relative: string;
    action: string;
    preview: unknown;
}

export interface ConsumerPlan {
    root: string;
    consumer: string;
    profile: { recipe: string; hostProfile: string; description?: string };
    files: ConsumerPlanFile[];
    warnings: string[];
    generatedAt: string;
}
