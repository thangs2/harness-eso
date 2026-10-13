import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDesignViewGraph,
    computeHighlightForRow,
    designBlueprint,
} from '../packages/harness-observe-server/src/decision-design-view.mjs';
import {
    buildEsoDesignGraph,
    computeEsoHighlight,
    esoBaselineBlueprint,
} from '../packages/harness-observe-server/src/eso-design-view.mjs';

const BP = designBlueprint();
const BP_NODE_IDS = new Set(BP.nodes.map((n) => n.id));
const BP_EDGE_IDS = new Set(BP.edges.map((e) => e.id));

/**
 * Ledger row shapes covering every branch of `computeHighlightForRow`. The per-request green
 * path is a hand-written link table, so a shape that is never exercised hides its own breaks —
 * the first audit of this found 6 of 10 shapes drawing an interrupted path.
 */
const ROW_SHAPES = [
    { name: 'turn_start · jev off · l0 win', row: { event_type: 'turn_start', jev_mode: 'off', enforced_verdict: 'route_l0', resolver_winner: 'l0_resolver' } },
    { name: 'turn_start · jev hint · l0 win (live shape)', row: { event_type: 'turn_start', jev_mode: 'hint', enforced_verdict: 'rule:tools', resolver_winner: 'l0_resolver', ambiguous_policy: 'hil_only' } },
    { name: 'turn_start · jev shadow · usedJev', row: { event_type: 'turn_start', jev_mode: 'shadow', enforced_verdict: 'route_l0', resolver_winner: 'l0_resolver', latency_ms_jev: 120, jev_response_json: '{}' } },
    { name: 'turn_start · jev shadow · l0 win', row: { event_type: 'turn_start', jev_mode: 'shadow', enforced_verdict: 'route_l0', resolver_winner: 'l0_resolver' } },
    { name: 'turn_start · jev active · jev win', row: { event_type: 'turn_start', jev_mode: 'active', enforced_verdict: 'route_jev', resolver_winner: 'jev_resolver', latency_ms_jev: 300, jev_response_json: '{}' } },
    { name: 'turn_start · jev active · hil', row: { event_type: 'turn_start', jev_mode: 'active', enforced_verdict: 'hil_only', resolver_winner: 'ambiguity_resolver', latency_ms_jev: 200, jev_response_json: '{}', ambiguous_policy: 'hil_only' } },
    { name: 'turn_start · l3 win', row: { event_type: 'turn_start', jev_mode: 'off', enforced_verdict: 'route_l3', resolver_winner: 'l3_resolver' } },
    { name: 'turn_start · safe_default', row: { event_type: 'turn_start', jev_mode: 'off', enforced_verdict: 'hil_only', resolver_winner: 'ambiguity_resolver', ambiguous_policy: 'safe_default' } },
    { name: 'pre_guard_shell · deny', row: { event_type: 'pre_guard_shell', jev_mode: 'off', enforced_verdict: 'deny', resolver_winner: 'l1_shell_deny' } },
    { name: 'pre_guard_shell · ask + jev', row: { event_type: 'pre_guard_shell', jev_mode: 'shadow', enforced_verdict: 'ask', resolver_winner: 'l1_shell_ask', latency_ms_jev: 90, jev_response_json: '{}' } },
];

/** Edges the canvas draws green, as `source->target` pairs, from a built graph. */
function activePairs(graph) {
    const byId = new Map(graph.edges.map((e) => [e.id, e]));
    return graph.edges
        .filter((e) => e.data?.active)
        .map((e) => byId.get(e.id))
        .map((e) => `${e.source}->${e.target}`);
}

function activeNodeIds(graph) {
    return graph.nodes.filter((n) => n.data?.active).map((n) => n.id);
}

const graphFor = (row) => buildDesignViewGraph([row]);

test('the decision link table never references an edge the blueprint does not define', () => {
    // A phantom id is dropped silently by the renderer, so the two nodes it was meant to join
    // both show green with a gray line between them. This is the drift that produced the breaks.
    for (const { name, row } of ROW_SHAPES) {
        const h = computeHighlightForRow(row);
        const unknownEdges = [...h.edges].filter((id) => !BP_EDGE_IDS.has(id));
        const unknownNodes = [...h.nodes].filter((id) => !BP_NODE_IDS.has(id));
        assert.deepEqual(unknownEdges, [], `${name}: unknown edge id(s) referenced`);
        assert.deepEqual(unknownNodes, [], `${name}: unknown node id(s) referenced`);
    }
});

test('the decision graph never leaves both endpoints green with a gray edge between', () => {
    for (const { name, row } of ROW_SHAPES) {
        const g = graphFor(row);
        const act = new Set(activeNodeIds(g));
        const gaps = activePairs(g).length
            ? BP.edges
                  .filter((e) => act.has(e.source) && act.has(e.target))
                  .filter((e) => !g.edges.find((x) => x.id === e.id)?.data?.active)
                  .map((e) => e.id)
            : [];
        assert.deepEqual(gaps, [], `${name}: interrupted green path`);
    }
});

test('the decision graph never paints a green node with no green connection', () => {
    for (const { name, row } of ROW_SHAPES) {
        const g = graphFor(row);
        const real = new Set(
            g.edges.filter((e) => e.data?.active).map((e) => e.id),
        );
        const touched = new Set();
        for (const e of BP.edges) {
            if (real.has(e.id)) {
                touched.add(e.source);
                touched.add(e.target);
            }
        }
        const lonely = activeNodeIds(g).filter((n) => !touched.has(n));
        assert.deepEqual(lonely, [], `${name}: isolated green node(s)`);
    }
});

test('the decision path reaches the ledger and its DecisionResult terminal', () => {
    // The chain the operator reads: prompt → hooks → facade → collect → measure → ledger → result.
    const g = graphFor(ROW_SHAPES[1].row);
    const pairs = activePairs(g);
    for (const required of [
        'U->AG',
        'AG->T0',
        'T0->HK',
        'HK->R',
        'R->P',
        'P->PH_C',
        'R->DB',
        'PKG->LED',
        'LED->POL_DRES',
    ]) {
        assert.ok(pairs.includes(required), `missing link in the green path: ${required}`);
    }
});

test('every ESO topology level keeps the chain continuous and references real ids', () => {
    const eso = esoBaselineBlueprint();
    const esoEdgeIds = new Set(eso.edges.map((e) => e.id));
    const esoNodeIds = new Set(eso.nodes.map((n) => n.id));
    for (const level of ['sufficient', 'partial', 'insufficient']) {
        const raw = computeEsoHighlight(level, {});
        assert.deepEqual(
            [...raw.edges].filter((id) => !esoEdgeIds.has(id)),
            [],
            `${level}: unknown edge id(s)`,
        );
        assert.deepEqual(
            [...raw.nodes].filter((id) => !esoNodeIds.has(id)),
            [],
            `${level}: unknown node id(s)`,
        );

        const g = buildEsoDesignGraph(level, {});
        const act = new Set(activeNodeIds(g));
        const gaps = eso.edges
            .filter((e) => act.has(e.source) && act.has(e.target))
            .filter((e) => !g.edges.find((x) => x.id === e.id)?.data?.active)
            .map((e) => e.id);
        assert.deepEqual(gaps, [], `${level}: interrupted green path`);
    }
});

test('unknown ESO level highlights nothing rather than guessing a path', () => {
    for (const level of ['unknown', '', undefined, null]) {
        const g = buildEsoDesignGraph(level, {});
        assert.deepEqual(activeNodeIds(g), []);
        assert.deepEqual(activePairs(g), []);
    }
});
