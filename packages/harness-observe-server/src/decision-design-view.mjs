/**
 * Design blueprint for Observatory — taxonomy from
 * x79 document/harness/02.harness-eso/19.diagrams-mermaid.md
 * (§V5 system context · §V3 L0–L4 · Phase A facade · policy jev.mode).
 * Gray static graph + per-request green highlight from decision_ledger.
 */

/** @typedef {{ nodes: Set<string>, edges: Set<string> }} Highlight */

const DIM = { fill: '#252b36', stroke: '#3d4654', label: '#6b7280', edge: '#2f3640' };
const ACT = { fill: '#1a3d2e', stroke: '#4ec97a', label: '#d1fae5', edge: '#4ec97a' };

function N(id, label, combo, tip = '') {
    return { id, data: { label, combo, tip, kind: 'blueprint' } };
}
function E(id, source, target) {
    return { id, source, target, data: { kind: 'blueprint' } };
}

function edgeId(a, b) {
    return `${a}--${b}`;
}

/** Canonical blueprint — combo titles are operator-facing; nodes follow 19 §V5 / §V3 / facade / policy. */
export function designBlueprint() {
    const combos = [
        { id: 'c1', data: { label: '§1 System context' } },
        { id: 'c2', data: { label: '§2 Layer stack L0→L4' } },
        { id: 'c3', data: { label: '§3 Decision Facade' } },
        { id: 'c4', data: { label: '§4 Policy · jev.mode' } },
    ];
    const nodes = [];
    const edges = [];
    const pushN = (n) => nodes.push(n);
    const pushE = (a, b) => edges.push(E(edgeId(a, b), a, b));

    // §1 — 19 §V5 System 1 + System 2 (full turn, greenfield packages)
    for (const [id, label, tip] of [
        ['U', 'Developer prompt', '§V5 client'],
        ['AG', 'IDE agent loop', '§V5 client'],
        ['T0', 'preflight / turn_start hook', '§V5 gate · host'],
        ['T2', 'pre_guard_shell optional', '§V5 · L1 shell band'],
        ['HK', 'host hooks · sidecar HTTP', '@mu/harness-host-generic'],
        ['R', 'Phase A · Facade L0 L1 L2', '@mu/harness-decision'],
        ['P', 'Phase B Collect', '@mu/harness-eso-core COLLECT'],
        ['PH_C', 'Phase C Measure', 'GATE measure · T_low / T_high'],
        ['PH_D', 'Phase D Escalate', 'expand · Jev · consent'],
        ['EB', 'EvidenceBundle', 'TurnVerdict stitch'],
        ['JEV', 'Jev max 1 per boundary', 'System 1 paid'],
        ['DB', 'harness.db ledger', 'SQLite WAL'],
        ['DG', 'law docgraph', 'L0 adapter'],
        ['CG', 'code codegraph', 'L0 adapter'],
        ['MEM', 'memory recall', 'L0 adapter'],
        ['ING', 'observe ingest', '§V15 read model'],
        ['UI', 'Harness Observatory', '§V13 observe plane'],
        ['BR', 'Brain Pro or Flash', '§V5 System 2 L4'],
        ['ST', 'pipeline brain stamp', '§V5'],
        ['EX', 'Flash executor', '§V5'],
        ['V', 'verify build test', '§V5'],
        ['GW', 'guard-write · guard-brain', '§V5 gate'],
        ['CONSENT', 'Human consent · HIL', '04.consent-gate'],
    ]) {
        pushN(N(id, label, 'c1', tip));
    }
    pushE('U', 'AG');
    pushE('AG', 'T0');
    pushE('T0', 'HK');
    pushE('HK', 'R');
    pushE('R', 'P');
    pushE('P', 'DG');
    pushE('P', 'CG');
    pushE('P', 'MEM');
    pushE('P', 'PH_C');
    pushE('PH_C', 'EB');
    pushE('PH_C', 'PH_D');
    pushE('PH_D', 'JEV');
    pushE('PH_D', 'P');
    pushE('PH_D', 'CONSENT');
    pushE('R', 'DB');
    pushE('PH_C', 'DB');
    pushE('PH_D', 'DB');
    pushE('HK', 'ING');
    pushE('ING', 'DB');
    pushE('DB', 'UI');
    pushE('EB', 'AG');
    pushE('AG', 'BR');
    pushE('BR', 'ST');
    pushE('ST', 'EX');
    pushE('EX', 'GW');
    pushE('GW', 'V');
    pushE('AG', 'T2');
    pushE('T2', 'R');
    // Phase A issues the one paid System-1 call per boundary; the highlight table already
    // assumed this edge existed.
    pushE('R', 'JEV');

    // §2 — 19 §V3 thang L0 → L4 (chi phí / mơ hồ)
    for (const [id, label, tip] of [
        ['L0', 'L0 tools · route graph · rules', 'turn_start · Phase A'],
        ['L1', 'L1 heuristic · shell guard', 'tie-break · pre_guard_shell'],
        ['L2', 'L2 Jev System 1 schema', 'route or sufficiency · Phase A/D'],
        ['L3', 'L3 Flash JSON route', 'policy l3_flash · rare'],
        ['L4', 'L4 Brain · executor · verify', 'System 2 · after GATE'],
        ['L_STOP', 'Stop · ask human', 'insufficient · hil_only'],
    ]) {
        pushN(N(id, label, 'c2', tip));
    }
    pushE('L0', 'L1');
    pushE('L1', 'L2');
    pushE('L2', 'L3');
    pushE('L3', 'L4');
    pushE('L2', 'L0');
    pushE('L1', 'L_STOP');

    // §3 — Phase A facade internals (01 taxonomy · V1 phaseA chain)
    for (const [id, label, tip] of [
        ['ENTRY', 'decide · turn_start', '@mu/harness-decision entry'],
        ['POL', 'policy loader', 'profiles/generic-eso · decision-policy.json'],
        ['CACHE', 'decision cache', 'hash + TTL'],
        ['ORCH', 'orchestrator', ''],
        ['R0', 'L0Resolver', 'route-graph.json'],
        ['R1', 'L1Resolver', 'checks · shell fuzzy'],
        ['R2', 'JevResolver', 'HTTP System 1'],
        ['R2S', 'shadow: log only', 'jev.mode shadow'],
        ['R2A', 'active: enforce', 'jev.mode active'],
        ['R3', 'L3Resolver', 'Flash JSON schema'],
        ['R4', 'AmbiguityResolver', 'hil_only · safe_default'],
        ['PKG', 'RoutePackage', 'SkillPack id'],
        ['GVR', 'GuardVerdict', 'allow · ask · deny'],
        ['LED', 'LedgerRow', 'decision_ledger'],
        ['CTX', 'AgentContextPatch', ''],
    ]) {
        pushN(N(id, label, 'c3', tip));
    }
    pushE('ENTRY', 'POL');
    pushE('ENTRY', 'ORCH');
    pushE('ORCH', 'CACHE');
    pushE('ORCH', 'R0');
    pushE('R0', 'PKG');
    pushE('R0', 'R1');
    pushE('R1', 'GVR');
    pushE('R1', 'R2');
    // An L1 tie can be handed to the ambiguity resolver instead of Jev.
    pushE('R1', 'R4');
    pushE('R2', 'R2S');
    pushE('R2', 'R2A');
    pushE('R2', 'R4');
    pushE('R2', 'R3');
    pushE('R2S', 'R4');
    pushE('R2A', 'PKG');
    pushE('R2A', 'GVR');
    // In active mode Jev's answer still goes through the ambiguity resolver.
    pushE('R2A', 'R4');
    pushE('R3', 'PKG');
    pushE('R3', 'R4');
    pushE('R4', 'LED');
    pushE('R4', 'CTX');
    pushE('PKG', 'LED');
    pushE('GVR', 'LED');

    // §4 — decision-policy.json jev.mode + on_ambiguous
    for (const [id, label] of [
        ['POL_START', 'Load policy'],
        ['POL_JEV', 'jev.mode'],
        ['POL_OFF', 'Skip Jev HTTP'],
        ['POL_SH', 'Jev shadow'],
        ['POL_AC', 'Jev active'],
        ['POL_AMB', 'on_ambiguous'],
        ['POL_AMB2', 'L0/L1 + log shadow'],
        ['POL_AMB3', 'Jev thresholds'],
        ['POL_HIL', 'hil_only'],
        ['POL_SD', 'safe_default'],
        ['POL_L3R', 'L3Resolver'],
        ['POL_P4', 'L4 Pro escalate'],
        ['POL_DRES', 'DecisionResult'],
    ]) {
        pushN(N(id, label, 'c4', 'generic-eso · 19 taxonomy'));
    }
    pushE('POL_START', 'POL_JEV');
    pushE('POL_JEV', 'POL_OFF');
    pushE('POL_JEV', 'POL_SH');
    pushE('POL_JEV', 'POL_AC');
    pushE('POL_OFF', 'POL_AMB');
    pushE('POL_SH', 'POL_AMB2');
    pushE('POL_AC', 'POL_AMB3');
    pushE('POL_AMB', 'POL_HIL');
    pushE('POL_AMB', 'POL_SD');
    pushE('POL_AMB', 'POL_L3R');
    pushE('POL_AMB', 'POL_P4');
    pushE('POL_AMB2', 'POL_DRES');
    pushE('POL_AMB3', 'POL_DRES');
    pushE('POL_HIL', 'POL_DRES');
    pushE('POL_SD', 'POL_DRES');
    pushE('POL_L3R', 'POL_DRES');
    pushE('POL_P4', 'POL_DRES');
    // §3's LedgerRow IS this request's DecisionResult, so the two combos converge here.
    // `computeHighlightForRow` already links them; the edge has to exist for that id to
    // resolve, otherwise POL_DRES lights up as an island with no line into it.
    pushE('LED', 'POL_DRES');

    return { combos, nodes, edges };
}

/**
 * @param {object} row — ledger row (snake_case)
 * @returns {Highlight}
 */
export function computeHighlightForRow(row) {
    const nodes = new Set();
    const edges = new Set();
    const add = (n) => nodes.add(n);
    const link = (a, b) => {
        add(a);
        add(b);
        edges.add(edgeId(a, b));
    };

    const eventType = row.event_type || row.eventType || 'turn_start';
    const jevMode = row.jev_mode || row.jevMode || 'off';
    const verdict = row.enforced_verdict || row.enforcedVerdict || '';
    const winner = row.resolver_winner || row.resolverWinner || '';
    const amb = row.ambiguous_policy || row.ambiguousPolicy || 'hil_only';
    const jevMs = row.latency_ms_jev || row.latencyMsJev || 0;
    const jevJson = row.jev_response_json || row.jevResponseJson;
    const usedJev = jevMode !== 'off' && (jevMs > 0 || jevJson);

    const policyTail = () => {
        link('POL_START', 'POL_JEV');
        link('POL_JEV', jevMode === 'active' ? 'POL_AC' : jevMode === 'shadow' ? 'POL_SH' : 'POL_OFF');
        if (jevMode === 'shadow') {
            link('POL_SH', 'POL_AMB2');
            link('POL_AMB2', 'POL_DRES');
        } else if (jevMode === 'active') {
            link('POL_AC', 'POL_AMB3');
        } else {
            link('POL_OFF', 'POL_AMB');
        }
    };

    /**
     * Both event paths terminate at the same node: §4's DecisionResult. It is linked from
     * LED, which is where the row is actually written (§3), so the terminal is reachable
     * instead of floating. Skipped when nothing else is active — a lone DecisionResult would
     * be a green island on an otherwise gray canvas.
     */
    const finishWithDecisionResult = () => {
        if (!nodes.size || nodes.has('POL_DRES')) return;
        add('POL_DRES');
        if (nodes.has('LED')) edges.add(edgeId('LED', 'POL_DRES'));
    };

    if (eventType === 'pre_guard_shell') {
        // Blueprint models this as AG→T2→R (T2 is the shell guard hook). The old
        // `T2→HK→ROCH→R1` chain used three edges the blueprint does not define, so nothing
        // was drawn between the guard and the facade.
        link('AG', 'T2');
        link('T2', 'R');
        link('ENTRY', 'POL');
        link('ENTRY', 'ORCH');
        // The resolver ladder is ORCH→R0→R1 in the blueprint, not ORCH→R1.
        link('ORCH', 'R0');
        link('R0', 'R1');
        link('R1', 'GVR');
        link('L1', 'L2');
        if (usedJev) {
            link('R1', 'R2');
            link('R2', jevMode === 'active' ? 'R2A' : 'R2S');
            // Only the ACTIVE resolver can override the guard verdict (R2A→GVR exists).
            // Shadow only logs, so it must not claim that edge.
            if (jevMode === 'active') link('R2A', 'GVR');
            link('R', 'JEV');
            link('L2', 'L3');
        }
        link('GVR', 'LED');
        policyTail();
        finishWithDecisionResult();
        return { nodes, edges };
    }

    // turn_start — Phase A surface + the ingest branch that lands in the ledger.
    //
    // Every id passed to `link` must exist in designBlueprint()'s edge list. `active.edges` is
    // a set of id STRINGS matched against the graph's real edges, so an id with no matching
    // edge is dropped without error — and the two nodes it was meant to join both render
    // green with a gray line between them, i.e. a visible break in the path.
    link('U', 'AG');
    link('AG', 'T0');
    link('T0', 'HK');
    // Main chain: the host hook invokes the facade. This edge was missing, so the path jumped
    // from HK to R across empty space.
    link('HK', 'R');
    // Ingest branch: the hooks also feed the transcript ingest, which writes the ledger.
    link('HK', 'ING');
    link('ING', 'DB');
    // The facade WRITES the row — the blueprint edge is `R -> DB`. The previous `DB -> R` was
    // both the wrong direction and absent, so neither end was ever drawn.
    link('R', 'DB');
    link('R', 'P');
    link('P', 'DG');
    link('P', 'CG');
    link('P', 'MEM');
    link('P', 'PH_C');
    // Phase C persists its measurement to the same ledger.
    link('PH_C', 'DB');
    link('ENTRY', 'POL');
    link('ENTRY', 'ORCH');
    link('ORCH', 'R0');
    link('L0', 'L1');

    const l0Win =
        verdict === 'route_l0' ||
        winner === 'l0_resolver' ||
        (verdict.startsWith('route_') && !verdict.includes('jev') && !verdict.includes('l3'));
    const jevWin = verdict.includes('jev') || winner.includes('jev');
    const l3Win = verdict.includes('l3') || String(winner).includes('l3');
    const hil = verdict === 'hil_only' || winner.includes('ambiguity') || winner.includes('hil');

    if (l0Win && !hil && !jevWin) {
        link('R0', 'PKG');
        link('PKG', 'LED');
    } else {
        link('R0', 'R1');
        if (usedJev || jevMode !== 'off') {
            link('R1', 'R2');
            link('L1', 'L2');
            link('R', 'JEV');
            policyTail();
            if (jevMode === 'shadow') link('R2', 'R2S');
            else if (jevMode === 'active') link('R2', 'R2A');
            if (jevWin && jevMode === 'active') {
                link('R2A', 'PKG');
                link('PKG', 'LED');
            } else if (jevMode === 'shadow') {
                link('R2S', 'R4');
            } else if (jevMode === 'active' && hil) {
                link('R2A', 'R4');
            }
        }
        if (l3Win) {
            link('R2', 'R3');
            link('L2', 'L3');
            link('R3', 'PKG');
            link('POL_START', 'POL_JEV');
            link('POL_JEV', 'POL_OFF');
            link('POL_AMB', 'POL_L3R');
            link('POL_L3R', 'POL_DRES');
        }
        if (hil || winner.includes('ambiguity')) {
            link('R1', 'R4');
            link('R4', 'LED');
            link('R4', 'CTX');
            link('L1', 'L_STOP');
            link('PH_C', 'PH_D');
            link('PH_D', 'CONSENT');
            if (jevMode === 'off') {
                link('POL_START', 'POL_JEV');
                link('POL_JEV', 'POL_OFF');
                link('POL_OFF', 'POL_AMB');
            } else if (!usedJev && jevMode === 'active') {
                link('POL_START', 'POL_JEV');
                link('POL_JEV', 'POL_AC');
                link('POL_AC', 'POL_AMB3');
            }
            if (amb === 'hil_only' || hil) {
                link('POL_AMB', 'POL_HIL');
                link('POL_HIL', 'POL_DRES');
            } else if (amb === 'safe_default') {
                link('POL_AMB', 'POL_SD');
                link('POL_SD', 'POL_DRES');
            }
        }
    }

    finishWithDecisionResult();

    return { nodes, edges };
}

/** Merge highlights for multiple display rows (route + guards). */
export function mergeHighlights(highlights) {
    const nodes = new Set();
    const edges = new Set();
    for (const h of highlights) {
        for (const n of h.nodes) nodes.add(n);
        for (const e of h.edges) edges.add(e);
    }
    return { nodes, edges };
}

/**
 * Light every edge whose two endpoints are both active.
 *
 * The path is produced by a hand-written table of per-event links, and that table cannot know
 * which *sibling* links a given ledger row will also light. Every time two steps both ran while
 * the edge between them stayed gray, the canvas showed green node — green node — dim line, which
 * reads as "a step is missing". Closing over the active node set makes the green subgraph
 * connected by construction, so adding one entry to the link table can never re-open a hole.
 *
 * This never adds NODES, so it cannot invent a step that did not run.
 *
 * @param {{ nodes: Set<string>, edges: Set<string> }} active
 * @param {Array<{ id: string, source: string, target: string }>} blueprintEdges
 */
export function closeHighlightOverNodes(active, blueprintEdges) {
    const nodes = new Set(active.nodes);
    const edges = new Set(active.edges);
    for (const e of blueprintEdges) {
        if (nodes.has(e.source) && nodes.has(e.target)) edges.add(e.id);
    }
    return { nodes, edges };
}

/**
 * @param {object[]} displayRows — raw ledger rows (deduped)
 * @param {object} [meta]
 */
export function buildDesignViewGraph(displayRows, meta = {}, observedFallback = null) {
    const { combos, nodes, edges } = designBlueprint();
    const highlights = displayRows.map((r) => computeHighlightForRow(r));
    let active = mergeHighlights(highlights);
    if (!active.nodes.size && observedFallback?.nodes?.size) {
        active = observedFallback;
    } else if (observedFallback?.nodes?.size) {
        active = mergeHighlights([active, observedFallback]);
    }
    active = closeHighlightOverNodes(active, edges);

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
        title: 'Harness ESO taxonomy (19.diagrams-mermaid.md)',
        legend:
            'Gray = SoT 19 §V5 context · §V3 L0–L4 · Phase A facade · jev.mode policy. Green = this request.',
        meta,
    };
}

export { DIM, ACT };
