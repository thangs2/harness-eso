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
    zones: ConsumerZone[];
    headerProfile: string;
    presetVersion?: string;
    tools: Record<string, unknown>;
    team: { roles: string[]; presets?: string[] };
    gates: Record<string, unknown>;
    sources: Record<string, unknown>;
    protectedPaths: string[];
}

export const DEFAULT_PROFILE: ConsumerProfile = {
    id: '',
    name: '',
    root: '',
    repoUrl: '',
    hostMode: 'dual-ide',
    observePort: 8792,
    sdlcRoot: 'sdlc',
    zones: [
        { name: 'human', path: 'sdlc', headerProfile: 'human-v1' },
        { name: 'agent', path: '.agents', headerProfile: 'agent-v1' },
    ],
    headerProfile: 'standard-v1',
    presetVersion: '2026-11',
    tools: { jira: true, notion: false, plan: true },
    team: { roles: ['lead', 'build', 'verify', 'audit'] },
    gates: { design: true, build: true, verify: true, release: true },
    sources: { docgraph: true, codegraph: true, memory: false },
    protectedPaths: ['AGENTS.md', '.cursor/rules/', '.agents/rules/', 'sdlc/'],
};

export const ROLES = ['lead', 'build', 'verify', 'audit', 'operator'];
export const GATES = ['design', 'build', 'verify', 'release'];
export const SOURCES = ['docgraph', 'codegraph', 'memory'];
