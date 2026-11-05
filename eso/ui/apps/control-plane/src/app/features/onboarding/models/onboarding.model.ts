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
    version?: number;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
}

export const DEFAULT_PROFILE: ConsumerProfile = {
    id: '',
    name: '',
    root: '',
    repoUrl: '',
    hostMode: 'dual-ide',
    observePort: 8792,
    sdlcRoot: 'sdlc',
    profile: { recipe: 'pro', hostProfile: 'cursor-superset', description: 'Full external evidence' },
    integration: { jevMode: 'off', consent: true, hostPack: 'full', memoryAdapter: 'none' },
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
export const PROFILE_RECIPES = [
    {
        id: 'lite',
        name: 'Lite',
        description: 'Chỉ dùng host, không gọi dịch vụ ngoài.',
        sources: 'Không docgraph · không codegraph · không memory',
        requires: 'Không cần service ngoài; phù hợp máy yếu/offline.',
        bestFor: 'Repo nhỏ, policy cấm dữ liệu rời máy, bước đầu làm quen.',
    },
    {
        id: 'pro',
        name: 'Pro',
        description: 'Evidence đầy đủ từ law, code và memory.',
        sources: 'docgraph (law) · codegraph (code) · agentmemory (quyết định cũ)',
        requires: 'docgraph + codegraph + agentmemory đang chạy và index đã build.',
        bestFor: 'Team cần chứng minh vì sao thay đổi an toàn; repo nhiều service.',
    },
    {
        id: 'dsh-native',
        name: 'DSH native',
        description: 'Ưu tiên session memory của host, fallback agentmemory.',
        sources: 'docgraph · codegraph · host native memory → agentmemory',
        requires: 'DeepSeek Harness có session memory; graph services vẫn cần.',
        bestFor: 'Consumer chạy trên DSH, muốn giảm phụ thuộc memory server.',
    },
];
export const HOST_PROFILES = ['cursor-superset', 'agents-superset', 'claude-superset'];
export const GATES = ['design', 'build', 'verify', 'release'];
export const SOURCES = ['docgraph', 'codegraph', 'memory'];
