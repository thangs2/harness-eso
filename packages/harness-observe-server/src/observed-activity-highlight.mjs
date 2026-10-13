/**
 * Green blueprint path when decision_ledger is empty but ingest captured tools/events.
 */

function edgeId(a, b) {
    return `${a}--${b}`;
}

/** @param {Set<string>} nodes @param {Set<string>} edges */
function link(nodes, edges, a, b) {
    nodes.add(a);
    nodes.add(b);
    edges.add(edgeId(a, b));
}

/**
 * @param {{
 *   events?: { tool?: string; path?: string; eventType?: string }[],
 *   tools?: { tool: string }[],
 *   files?: { path?: string }[],
 *   attached?: { filePath?: string; type?: string }[],
 *   hasIngest?: boolean,
 * }} ctx
 */
export function computeObservedActivityHighlight(ctx) {
    const nodes = new Set();
    const edges = new Set();

    link(nodes, edges, 'U', 'AG');
    if (ctx.hasIngest !== false) {
        link(nodes, edges, 'AG', 'ING');
        link(nodes, edges, 'ING', 'DB');
        link(nodes, edges, 'DB', 'UI');
    }

    const names = new Set();
    for (const t of ctx.tools || []) {
        if (t?.tool) names.add(String(t.tool));
    }
    for (const e of ctx.events || []) {
        if (e?.tool) names.add(String(e.tool).replace(/^MCP:/, ''));
    }

    const touchAdapter = (id) => {
        nodes.add('P');
        nodes.add(id);
        edges.add(edgeId('P', id));
    };

    for (const n of names) {
        const low = n.toLowerCase();
        if (low.includes('codegraph')) touchAdapter('CG');
        if (low.includes('docgraph')) touchAdapter('DG');
        if (low.startsWith('memory_')) touchAdapter('MEM');
        if (/^ask_deepseek/.test(low)) {
            nodes.add('BR');
            nodes.add('JEV');
            edges.add(edgeId('AG', 'BR'));
        }
        if (low === 'task' || low === 'calldynamictool' || low.startsWith('subagent')) {
            nodes.add('EX');
            edges.add(edgeId('AG', 'EX'));
        }
        if (low === 'shell') {
            nodes.add('V');
            edges.add(edgeId('EX', 'V'));
        }
    }

    const paths = [
        ...(ctx.files || []).map((f) => f.path),
        ...(ctx.attached || []).map((a) => a.filePath),
        ...(ctx.events || []).map((e) => e.path),
    ].filter(Boolean);

    for (const p of paths) {
        const s = String(p);
        if (/AGENTS\.md$/i.test(s) || /\.mdc$/i.test(s) || /\/rules\//i.test(s) || /\/skills\//i.test(s)) {
            nodes.add('L0');
            nodes.add('R');
            edges.add(edgeId('L0', 'R'));
            break;
        }
    }

    if (names.size > 0) {
        nodes.add('BR');
        nodes.add('EX');
        edges.add(edgeId('AG', 'BR'));
        edges.add(edgeId('BR', 'EX'));
    }

    return { nodes, edges };
}
