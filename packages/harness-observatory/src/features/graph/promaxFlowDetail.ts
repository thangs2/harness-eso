/**
 * Mirrors baplatform harness monitor: detailFlowSteps, rule buckets, relPath.
 */

import { RULE_BUCKET_LABEL, RULE_BUCKET_ORDER, STAGE_LABEL } from './promaxFlowStyles';

const VERIFY_LIKE =
    /\b(bun\s+(run\s+)?(build|test)|tsc\b|npm\s+(run\s+)?(build|test)|vitest|jest|refresh\.sh|verify-app|verify-ingest)\b/;

const RULE_DOMAIN_BUCKETS = new Set(['core', 'delivery', 'workflow', 'stack', 'sdlc', 'brain', 'ux']);

export type FlowDetailInput = {
    attached?: Array<{ type?: string; filePath?: string }>;
    rules?: Array<{ ruleId?: string }>;
    events?: Array<{
        eventType?: string;
        tool?: string;
        path?: string;
        hookAt?: string;
        command?: string;
    }>;
    llmCalls?: Array<{ toolNames?: string }>;
    rootPath?: string;
};

export type FlowStepVm = {
    tool: string;
    path: string;
    command: string;
    stage: string;
    ruleBucket?: string;
    bucketLabel?: string;
};

export type RuleBucketGroup = {
    bucket: string;
    label: string;
    items: Array<{ path: string; attachType: string; bucket: string; bucketLabel: string }>;
};

function flowBase(p: string): string {
    return String(p || '').split(/[\\/]/).pop() || '';
}

export function relPath(rootPath: string | undefined, p: string | undefined): string {
    const root = String(rootPath || '').replace(/\\/g, '/');
    let s = String(p || '').replace(/\\/g, '/');
    if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
    return s;
}

function classifyAttachPath(filePath: string, attachType: string): string {
    const s = String(filePath || '').replace(/\\/g, '/');
    const low = s.toLowerCase();
    const t = String(attachType || '').toLowerCase();
    if (t.includes('skill') || /\/skills\//.test(low) || /\/SKILL\.md$/i.test(s)) return 'skill';
    if (/(^|\/)AGENTS\.md$/i.test(s)) return 'playbook';
    if (/.agents\/rules\//.test(low)) return 'agents-rules';
    if (/\.mdc$/i.test(s)) {
        const base = s.split('/').pop() || '';
        const domain = (base.split('.')[0] || '').toLowerCase();
        if (RULE_DOMAIN_BUCKETS.has(domain)) return domain;
        return 'rules-other';
    }
    return 'rules-other';
}

function flowRulesEntries(d: FlowDetailInput) {
    const seen = new Set<string>();
    const out: RuleBucketGroup['items'][number][] = [];
    const add = (filePath: string | undefined, attachType: string) => {
        const path = relPath(d.rootPath, filePath);
        if (!path || seen.has(path)) return;
        seen.add(path);
        const bucket = classifyAttachPath(path, attachType);
        out.push({
            path,
            attachType: attachType || '',
            bucket,
            bucketLabel: RULE_BUCKET_LABEL[bucket] || bucket,
        });
    };
    for (const a of d.attached || []) add(a.filePath, a.type || '');
    for (const r of d.rules || []) add(r.ruleId, 'request_rule');
    return out;
}

export function flowRulesByBucket(d: FlowDetailInput): RuleBucketGroup[] {
    const by = new Map<string, RuleBucketGroup['items']>();
    for (const e of flowRulesEntries(d)) {
        if (!by.has(e.bucket)) by.set(e.bucket, []);
        by.get(e.bucket)!.push(e);
    }
    for (const items of by.values()) {
        items.sort((a, b) => a.path.localeCompare(b.path));
    }
    return RULE_BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
        bucket: b,
        label: RULE_BUCKET_LABEL[b] || b,
        items: by.get(b)!,
    }));
}

export function stageOf(tool: string | undefined, command: string | undefined): string {
    const t = String(tool || '').replace(/^MCP:/, '');
    if (!t) return 'other';
    if (t === 'stop') return 'end';
    if (/^ask_deepseek/.test(t)) return 'brain';
    if (/^memory_/.test(t)) return /save$/.test(t) ? 'store' : 'memory';
    if (t === 'codegraph_explore') return 'codegraph';
    if (t === 'Shell' || t === 'run_command' || t === 'command') {
        const c = String(command || '');
        if (/\bdocgraph\b/.test(c)) return 'docgraph';
        if (VERIFY_LIKE.test(c)) return 'verify';
        return 'shell';
    }
    if (/^(Read|Grep|Glob|ReadLints|WebFetch|WebSearch|CallDynamicTool|view_file|grep_search|list_dir|read_url_content)$/.test(t)) return 'inspect';
    if (/^(Write|StrReplace|Delete|replace_file_content|write_to_file|multi_replace_file_content)$/.test(t)) return 'edit';
    if (/^browser_/.test(t)) return 'browser';
    if (/^(penpot|figma)/.test(t)) return 'design';
    if (/^(Task|subagent)/.test(t)) return 'agent';
    return 'other';
}

export function detailFlowSteps(d: FlowDetailInput): FlowStepVm[] {
    const steps: FlowStepVm[] = [];
    for (const g of flowRulesByBucket(d)) {
        for (const e of g.items) {
            const name = flowBase(e.path);
            steps.push({
                tool: name || g.label,
                path: e.path,
                command: e.attachType !== 'request_rule' ? e.attachType : '',
                stage: 'attach',
                ruleBucket: g.bucket,
                bucketLabel: g.label,
            });
        }
    }
    const traced = (d.events || [])
        .filter((e) => e.eventType === 'postToolUse')
        .sort((a, b) =>
            String(a.hookAt || '').localeCompare(String(b.hookAt || '')),
        );
    if (traced.length) {
        for (const e of traced) {
            steps.push({
                tool: e.tool || 'unknown',
                path: e.path || '',
                command: e.command || '',
                stage: stageOf(e.tool, e.command),
            });
        }
    } else {
        for (const c of d.llmCalls || []) {
            for (const t of String(c.toolNames || '')
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)) {
                steps.push({ tool: t, path: '', command: '', stage: stageOf(t, '') });
            }
        }
    }
    if (steps.length) {
        steps.push({ tool: 'stop', path: '', command: '', stage: 'end' });
    }
    return steps;
}

export function flowMetaLine(d: FlowDetailInput, steps: FlowStepVm[]): string {
    const tracedCount = (d.events || []).filter((e) => e.eventType === 'postToolUse').length;
    if (!steps.length) return '';
    return tracedCount
        ? `${steps.length} step(s) · from the hook trace`
        : `${steps.length} step(s) · from the transcript — this turn has no hook trace, so there is no shell command and docgraph cannot be seen`;
}

export { flowBase, STAGE_LABEL };
