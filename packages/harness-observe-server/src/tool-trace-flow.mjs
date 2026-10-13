/**
 * Promax-style flow graph: attached rules/skills + tool trace spine for one request.
 */

function N(nodes, id, combo, label, extra = {}) {
    nodes.push({
        id,
        combo,
        data: { label, kind: 'trace', active: true, ...extra },
    });
    return id;
}

function E(edges, source, target, label) {
    edges.push({
        id: `${source}--${target}`,
        source,
        target,
        data: { active: true, label },
    });
}

/**
 * @param {{ userQuery?: string, llmCalls?: object[], tools?: {tool:string,count:number}[], attached?: {type?:string,filePath?:string}[], events?: object[] }} input
 */
export function buildToolTraceFlowGraph(input) {
    const combos = [
        { id: 'route', data: { label: 'Route (rules · skills)' } },
        { id: 'trace', data: { label: 'Tool trace (ingest order)' } },
    ];
    const nodes = [];
    const edges = [];

    const query = String(input.userQuery || 'Turn').slice(0, 56);
    const turn = N(nodes, 'turn', 'trace', query ? `Prompt · ${query}` : 'User prompt');

    const attached = input.attached ?? [];
    const rules = attached.filter((a) => a.type === 'rule' || /\.mdc$/.test(a.filePath || ''));
    const skills = attached.filter((a) => a.type === 'skill' || /skills\//.test(a.filePath || ''));
    const ruleLabels =
        rules.length > 0
            ? rules.slice(0, 8).map((r) => r.filePath?.split('/').pop() || 'rule')
            : [];
    const skillLabels =
        skills.length > 0
            ? skills.slice(0, 8).map((s) => s.filePath?.split('/').pop() || 'skill')
            : [];

    if (ruleLabels.length) {
        N(nodes, 'rules', 'route', `Rules (${ruleLabels.length})`, { tip: ruleLabels.join(', ') });
        E(edges, turn, 'rules', 'attached');
    } else {
        N(nodes, 'rules', 'route', 'Rules (from trace)', { active: false, kind: 'blueprint' });
    }

    if (skillLabels.length) {
        N(nodes, 'skills', 'route', `Skills (${skillLabels.length})`, { tip: skillLabels.join(', ') });
        if (ruleLabels.length) E(edges, 'rules', 'skills');
        else E(edges, turn, 'skills', 'skills');
    }

    const toolChain = [];
    for (const c of input.llmCalls ?? []) {
        const names = String(c.toolNames || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        for (const t of names) toolChain.push(t);
    }
    if (!toolChain.length && input.tools?.length) {
        for (const t of input.tools) {
            for (let i = 0; i < Math.min(t.count || 1, 12); i++) toolChain.push(t.tool);
        }
    }

    let prev = turn;
    if (ruleLabels.length) {
        E(edges, prev, 'rules');
        prev = 'rules';
    }
    if (skillLabels.length) {
        E(edges, prev, 'skills');
        prev = 'skills';
    }

    toolChain.slice(0, 24).forEach((tool, i) => {
        const id = `tool-${i}`;
        N(nodes, id, 'trace', tool, { layer: `step ${i + 1}` });
        E(edges, prev, id);
        prev = id;
    });

    const answerCall = [...(input.llmCalls ?? [])].reverse().find((c) => c.kind === 'answer' || c.toolCount === 0);
    N(nodes, 'answer', 'trace', answerCall ? 'Answer' : 'End', { kind: 'verdict' });
    E(edges, prev, 'answer');

    return {
        combos,
        nodes,
        edges,
        legend: 'Green path = transcript tool order + route attachments (promax flow graph). Hook-linked trace improves rule nodes.',
        title: 'Flow · rules/skills + tools',
    };
}
