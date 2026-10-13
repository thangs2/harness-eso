/**
 * Promax flow graph (baplatform tools/monitors/harness) — rules/skills combos + stage hubs.
 */

const STAGE_ORDER = [
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
const STAGE_LABEL = {
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
const VERIFY_LIKE =
    /\b(bun\s+(run\s+)?(build|test)|tsc\b|npm\s+(run\s+)?(build|test)|vitest|jest|refresh\.sh|verify-app|verify-ingest)\b/;

const RULE_BUCKET_ORDER = [
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
const RULE_BUCKET_LABEL = {
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

const LABEL_MAX = 52;

function flowBase(p) {
    return String(p || '').split(/[\\/]/).pop();
}
function flowTrim(s, n) {
    const t = String(s || '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function relPath(rootPath, p) {
    const root = String(rootPath || '').replace(/\\/g, '/');
    let s = String(p || '').replace(/\\/g, '/');
    if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
    return s;
}

function stageOf(tool, command) {
    const t = String(tool || '').replace(/^MCP:/, '');
    if (!t) return 'other';
    if (t === 'stop') return 'end';
    if (/^ask_deepseek/.test(t)) return 'brain';
    if (/^memory_/.test(t)) return /save$/.test(t) ? 'store' : 'memory';
    if (t === 'codegraph_explore') return 'codegraph';
    if (t === 'Shell') {
        const c = String(command || '');
        if (/\bdocgraph\b/.test(c)) return 'docgraph';
        if (VERIFY_LIKE.test(c)) return 'verify';
        return 'shell';
    }
    if (/^(Read|Grep|Glob|ReadLints|WebFetch|WebSearch|CallDynamicTool)$/.test(t)) return 'inspect';
    if (/^(Write|StrReplace|Delete)$/.test(t)) return 'edit';
    if (/^browser_/.test(t)) return 'browser';
    if (/^(penpot|figma)/.test(t)) return 'design';
    if (/^(Task|subagent)/.test(t)) return 'agent';
    return 'other';
}

const RULE_DOMAIN_BUCKETS = new Set(['core', 'delivery', 'workflow', 'stack', 'sdlc', 'brain', 'ux']);

function classifyAttachPath(filePath, attachType) {
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

function flowRulesEntries(d) {
    const seen = new Set();
    const out = [];
    const rootPath = d.rootPath;
    const add = (filePath, attachType) => {
        const path = relPath(rootPath, filePath);
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
    for (const a of d.attached || []) add(a.filePath, a.type);
    for (const r of d.rules || []) add(r.ruleId, 'request_rule');
    return out;
}

function flowRulesByBucket(d) {
    const by = new Map();
    for (const e of flowRulesEntries(d)) {
        if (!by.has(e.bucket)) by.set(e.bucket, []);
        by.get(e.bucket).push(e);
    }
    for (const items of by.values()) {
        items.sort((a, b) => a.path.localeCompare(b.path));
    }
    return RULE_BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
        bucket: b,
        label: RULE_BUCKET_LABEL[b] || b,
        items: by.get(b),
    }));
}

/**
 * @param {{
 *   userQuery?: string,
 *   attached?: { type?: string, filePath?: string }[],
 *   rules?: { ruleId?: string }[],
 *   events?: { eventType?: string, tool?: string, path?: string, command?: string }[],
 *   rootPath?: string,
 * }} input
 */
export function buildPromaxFlowGraph(input) {
    const d = {
        request: { user_query: input.userQuery },
        attached: input.attached,
        rules: input.rules,
        events: input.events,
        rootPath: input.rootPath,
    };

    const combos = [];
    const nodes = [];
    const edges = [];
    let ei = 0;
    const N = (id, data, combo) => {
        const row = combo ? { id, combo, data: { ...data } } : { id, data: { ...data } };
        nodes.push(row);
        return id;
    };
    const E = (source, target) => {
        edges.push({ id: `e${ei++}`, source, target });
    };

    const prompt = flowTrim(d.request?.user_query || '(prompt)', 42);
    N('root', { kind: 'root', label: prompt, tip: prompt });

    const ruleGroups = flowRulesByBucket(d);
    const traced = (d.events || [])
        .filter((e) => e.eventType === 'postToolUse')
        .sort((a, b) =>
            String(a.hookAt || a.hook_at || '').localeCompare(String(b.hookAt || b.hook_at || '')),
        );
    if (!ruleGroups.length && !traced.length) return null;

    for (const g of ruleGroups) {
        const comboId = `combo-attach-${g.bucket}`;
        combos.push({ id: comboId, data: { label: g.label } });
        for (let ri = 0; ri < g.items.length; ri += 1) {
            const e = g.items[ri];
            const tip = [e.bucketLabel, e.attachType, e.path].filter(Boolean).join('\n');
            const label = flowTrim(flowBase(e.path), LABEL_MAX);
            const ruleId = N(
                `rule:${g.bucket}:${ri}`,
                {
                    kind: 'rule',
                    ruleBucket: g.bucket,
                    label,
                    tip,
                },
                comboId,
            );
            E('root', ruleId);
        }
    }

    const byStage = new Map();
    traced.forEach((e, i) => {
        const st = stageOf(e.tool, e.command);
        if (!byStage.has(st)) byStage.set(st, []);
        byStage.get(st).push({ e, i });
    });
    const stages = STAGE_ORDER.filter((s) => byStage.has(s) && s !== 'attach');
    let prevHub = 'root';
    for (const st of stages) {
        const comboId = `combo-${st}`;
        const items = byStage.get(st);
        combos.push({ id: comboId, data: { label: STAGE_LABEL[st] || st } });
        const hubId = N(
            `hub:${st}`,
            {
                kind: 'hub',
                stage: st,
                label: STAGE_LABEL[st] || st,
                tip: `${items.length} call(s) in this stage`,
            },
            comboId,
        );
        E(prevHub, hubId);
        prevHub = hubId;
        for (const { e, i } of items) {
            const tool = String(e.tool || 'unknown').replace(/^MCP:/, '');
            const p = e.path ? relPath(d.rootPath, e.path) : '';
            const cmd = String(e.command || '').trim();
            let label = p ? `${tool} · ${flowTrim(p, LABEL_MAX - tool.length - 3)}` : tool;
            label = flowTrim(label, LABEL_MAX);
            const tipLines = [`#${i + 1}`, STAGE_LABEL[st] || st, tool];
            if (p) tipLines.push(p);
            if (cmd && cmd !== tool) tipLines.push(cmd);
            const stepId = N(
                `step:${st}:${i}`,
                { kind: 'step', stage: st, label, tip: tipLines.join('\n') },
                comboId,
            );
            E(hubId, stepId);
        }
    }
    return { nodes, edges, combos };
}

export { STAGE_ORDER, STAGE_LABEL, RULE_BUCKET_ORDER, RULE_BUCKET_LABEL };
