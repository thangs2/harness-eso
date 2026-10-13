import { closeHighlightOverNodes } from './decision-design-view.mjs';

/**
 * ESO Observatory topology — 19.diagrams-mermaid.md §V11 preflight vs ingest,
 * §V12 cognition tiers, §V6 data plane Phases B–D.
 * Gray blueprint + green highlight from EvidenceBundle / sufficiency ledger.
 */

function N(id, label, combo, tip = '') {
    return { id, data: { label, combo, tip, kind: 'blueprint' } };
}
function E(id, source, target) {
    return { id, source, target, data: { kind: 'blueprint' } };
}

function edgeId(a, b) {
    return `${a}--${b}`;
}

/** Canonical ESO blueprint (greenfield SoT). */
export function esoBaselineBlueprint() {
    const combos = [
        { id: 'eV12', data: { label: '§V12 Cognition tiers 1–3' } },
        { id: 'eV11', data: { label: '§V11 Preflight sync vs ingest async' } },
        { id: 'eV6', data: { label: '§V6 ESO data plane B–D' } },
    ];
    const nodes = [];
    const edges = [];
    const pushN = (n) => nodes.push(n);
    const pushE = (a, b) => edges.push(E(edgeId(a, b), a, b));

    // §V12 — cognition tiers
    for (const [id, label, tip] of [
        ['PF', 'runPreflight', 'tier 1'],
        ['INJ', 'IDE additional_context ESO COGNITION', 'tier 1'],
        ['ART', '.eso-preflight.json', 'tier 1'],
        ['RECON', 'recon docgraph codegraph memory Read', 'tier 3'],
        ['GAP', 'gap closure attestation', 'tier 3'],
        ['BR', 'Brain MCP explicit tier', 'tier 2'],
        ['GB', 'guard-brain preToolUse', 'tier 2'],
        ['DENY', 'deny submit insufficient', 'tier 3 policy'],
    ]) {
        pushN(N(id, label, 'eV12', tip));
    }
    pushE('PF', 'ART');
    pushE('ART', 'INJ');
    pushE('ART', 'RECON');
    pushE('RECON', 'GAP');
    pushE('GAP', 'GB');
    pushE('GB', 'BR');
    pushE('GB', 'RECON');
    pushE('ART', 'DENY');

    // §V11 — dual path
    for (const [id, label, tip] of [
        ['PROMPT', 'User prompt boundary', 'turn boundary'],
        ['PF_SYNC', 'orchestrateTurn phase preflight', 'sync max budget ms'],
        ['ART_SYNC', '.eso-preflight.json session tree', ''],
        ['DIS', 'Dispatcher gap fetch playbook', 'System 2'],
        ['BRAIN', 'Brain with EVIDENCE CONTEXT', 'System 2'],
        ['TOOLS', 'postToolUse hint once', ''],
        ['ORC', 'orchestrateTurn phase full', 'ingest async'],
        ['DB', 'harness.db ledger', ''],
        ['ST', '.eso-bundle-stamp.json', 'guard-write'],
    ]) {
        pushN(N(id, label, 'eV11', tip));
    }
    pushE('PROMPT', 'PF_SYNC');
    pushE('PF_SYNC', 'ART_SYNC');
    pushE('ART_SYNC', 'INJ');
    pushE('ART_SYNC', 'DIS');
    pushE('DIS', 'BRAIN');
    pushE('BRAIN', 'TOOLS');
    pushE('TOOLS', 'ORC');
    pushE('ORC', 'DB');
    pushE('PF_SYNC', 'ST');
    pushE('ORC', 'ST');

    // §V6 — Phase B–D only
    for (const [id, label, tip] of [
        ['R_SURF', 'Phase A surface RoutePackage', 'input to ESO'],
        ['PH_B', 'Phase B Evidence plan', 'Collect'],
        ['PH_C', 'Phase C Sufficiency', 'Measure'],
        ['PH_D', 'Phase D Escalate ladder', 'paid optional'],
        ['BUNDLE', 'EvidenceBundle stitch', ''],
        ['AD_DG', 'docgraph', 'adapter'],
        ['AD_CG', 'codegraph', 'adapter'],
        ['AD_MEM', 'agentmemory', 'adapter'],
        ['HIL', 'Consent or HIL', 'insufficient'],
    ]) {
        pushN(N(id, label, 'eV6', tip));
    }
    pushE('R_SURF', 'PH_B');
    pushE('PH_B', 'AD_DG');
    pushE('PH_B', 'AD_CG');
    pushE('PH_B', 'AD_MEM');
    pushE('PH_B', 'PH_C');
    pushE('PH_C', 'BUNDLE');
    pushE('PH_C', 'PH_D');
    pushE('PH_D', 'PH_B');
    pushE('PH_D', 'HIL');

    return { combos, nodes, edges };
}

/**
 * @param {string} level — sufficient | partial | insufficient
 * @param {object|null} bundle — EvidenceBundle from ledger
 * @returns {{ nodes: Set<string>, edges: Set<string> }}
 */
export function computeEsoHighlight(level, bundle) {
    const nodes = new Set();
    const edges = new Set();
    const add = (n) => nodes.add(n);
    const link = (a, b) => {
        add(a);
        add(b);
        edges.add(edgeId(a, b));
    };

    if (!level || level === 'unknown') {
        return { nodes, edges };
    }

    link('PF', 'ART');
    link('ART', 'INJ');

    if (level === 'sufficient') {
        link('GAP', 'GB');
        link('GB', 'BR');
    } else {
        link('ART', 'RECON');
        link('RECON', 'GAP');
        link('GAP', 'GB');
        if (level === 'insufficient') {
            link('ART', 'DENY');
            link('GB', 'RECON');
        } else {
            link('GB', 'RECON');
        }
    }

    link('PROMPT', 'PF_SYNC');
    link('PF_SYNC', 'ART_SYNC');
    // `.eso-preflight.json` feeds BOTH the sync injection and the async dispatcher. Only the
    // ART→INJ edge was lit, so the ingest-side artifact and the context injection both showed
    // green with the line between them gray.
    link('ART_SYNC', 'INJ');
    link('ART_SYNC', 'DIS');
    link('DIS', 'BRAIN');
    link('BRAIN', 'TOOLS');
    link('TOOLS', 'ORC');
    link('ORC', 'DB');
    link('ORC', 'ST');
    // Preflight also writes the bundle stamp straight away (blueprint: PF_SYNC→ST).
    link('PF_SYNC', 'ST');

    link('R_SURF', 'PH_B');
    link('PH_B', 'AD_DG');
    link('PH_B', 'AD_CG');
    link('PH_B', 'AD_MEM');
    link('PH_B', 'PH_C');
    link('PH_C', 'BUNDLE');
    if (level === 'partial' || level === 'insufficient') {
        link('PH_C', 'PH_D');
        // Phase D escalates by expanding the evidence plan again (blueprint: PH_D→PH_B).
        link('PH_D', 'PH_B');
    }
    if (level === 'insufficient') {
        link('PH_D', 'HIL');
    }

    const enforceWrites = bundle?.enforceWrites;
    if (enforceWrites === 'fail_closed' && level !== 'sufficient') {
        add('ST');
    }

    return { nodes, edges };
}

/**
 * @param {string} level
 * @param {object|null} [bundle]
 */
export function buildEsoDesignGraph(level, bundle = null) {
    const { combos, nodes, edges } = esoBaselineBlueprint();
    const active = closeHighlightOverNodes(computeEsoHighlight(level, bundle), edges);

    const gNodes = nodes.map((n) => ({
        id: n.id,
        combo: n.data.combo,
        data: {
            ...n.data,
            active: active.nodes.has(n.id),
        },
    }));
    const gEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        data: {
            active: active.edges.has(e.id),
        },
    }));

    return {
        combos,
        nodes: gNodes,
        edges: gEdges,
        activeNodeCount: active.nodes.size,
        activeEdgeCount: active.edges.size,
        legend:
            'Gray = 19.diagrams-mermaid.md §V11 · §V12 · §V6. Green = path implied by this request’s ESO ledger row.',
        level,
        esoMode: bundle?.esoMode ?? null,
        enforceWrites: bundle?.enforceWrites ?? null,
    };
}
