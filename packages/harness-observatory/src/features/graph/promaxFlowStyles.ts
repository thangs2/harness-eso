/** Literals mirrored from baplatform harness monitor (canvas cannot use CSS vars). */

export const STAGE_HEX: Record<string, string> = {
    attach: '#c084fc',
    brain: '#5aa9ff',
    memory: '#4ec97a',
    codegraph: '#22d3ee',
    docgraph: '#38bdf8',
    inspect: '#8b97ab',
    edit: '#e0b341',
    verify: '#4ec97a',
    shell: '#94a3b8',
    browser: '#f472b6',
    design: '#fb7185',
    agent: '#a78bfa',
    store: '#4ec97a',
    other: '#8b97ab',
    end: '#8b97ab',
};

export const RULE_BUCKET_HEX: Record<string, string> = {
    playbook: '#e5e7eb',
    core: '#c084fc',
    delivery: '#f472b6',
    workflow: '#fb7185',
    stack: '#38bdf8',
    sdlc: '#22d3ee',
    brain: '#5aa9ff',
    ux: '#fab387',
    'agents-rules': '#a78bfa',
    'rules-other': '#94a3b8',
    skill: '#4ec97a',
};

export const RULE_BUCKET_ORDER = [
    'playbook',
    'core',
    'delivery',
    'workflow',
    'stack',
    'sdlc',
    'brain',
    'ux',
    'agents-rules',
    'rules-other',
    'skill',
];

export const STAGE_ORDER = [
    'attach',
    'brain',
    'memory',
    'codegraph',
    'docgraph',
    'inspect',
    'edit',
    'verify',
    'shell',
    'browser',
    'design',
    'agent',
    'store',
    'other',
    'end',
];

export const STAGE_LABEL: Record<string, string> = {
    attach: 'rules/skills',
    brain: 'brain',
    memory: 'memory read',
    codegraph: 'codegraph',
    docgraph: 'docgraph',
    inspect: 'inspect',
    edit: 'edit',
    verify: 'verify',
    shell: 'shell',
    browser: 'browser',
    design: 'design',
    agent: 'agent',
    store: 'memory save',
    other: 'other',
    end: 'stop',
};

export const RULE_BUCKET_LABEL: Record<string, string> = {
    playbook: 'AGENTS.md playbook',
    core: 'Rules · core / pipeline',
    delivery: 'Rules · delivery / Jira / WBS',
    workflow: 'Rules · workflow / factory',
    stack: 'Rules · stack (ABP / FE)',
    sdlc: 'Rules · SDLC / governance',
    brain: 'Rules · brain / DeepSeek',
    ux: 'Rules · Penpot / UX',
    'agents-rules': 'Rules · .agents twin',
    'rules-other': 'Rules · other .mdc',
    skill: 'Skills (SKILL.md)',
};

export type FlowNodeData = {
    kind?: string;
    label?: string;
    tip?: string;
    stage?: string;
    ruleBucket?: string;
    active?: boolean;
};

export function flowNodeSize(nd: FlowNodeData): [number, number] {
    const len = (nd.label || '').length;
    if (nd.kind === 'root') return [Math.min(320, 24 + len * 6), 44];
    if (nd.kind === 'hub') return [Math.min(160, 18 + len * 5.5), 28];
    if (nd.kind === 'rule') return [Math.min(280, 20 + len * 5.4), 26];
    if (nd.kind === 'step') return [Math.min(320, 20 + len * 5.2), 24];
    return [140, 26];
}

export function flowNodeFill(nd: FlowNodeData): string {
    if (nd.kind === 'root') return '#e5e7eb';
    if (nd.kind === 'hub') return STAGE_HEX[nd.stage || ''] || '#8b97ab';
    if (nd.kind === 'rule') return RULE_BUCKET_HEX[nd.ruleBucket || ''] || '#c084fc';
    if (nd.kind === 'step') return '#3d4f63';
    return '#3b455c';
}

export function flowLabelFill(nd: FlowNodeData): string {
    if (nd.kind === 'step') return '#e8edf5';
    return '#0b0e14';
}

export function s1BlueprintNodeSize(nd: FlowNodeData): [number, number] {
    const len = (nd.label || '').length;
    return [Math.min(200, 18 + len * 5.2), 26];
}
