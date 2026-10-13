/**
 * System 1 decision path — ledger load + design blueprint (19.diagrams-mermaid.md §V5/V3).
 */
import { buildDesignViewGraph } from './decision-design-view.mjs';
import { computeObservedActivityHighlight } from './observed-activity-highlight.mjs';
import { buildSequenceViewGraph } from './decision-sequence-view.mjs';
import { formatEsoSummary, parseBundleFromLedgerRow } from './eso-view.mjs';

function safeJson(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function jevHint(jevJson) {
    const j = safeJson(jevJson);
    if (!j) return null;
    const inner = j.jev || j;
    const answers = inner.answers || inner;
    if (answers.route_bucket) return `route_bucket: ${JSON.stringify(answers.route_bucket)}`;
    if (answers.needs_human?.noul != null) return `needs_human noul: ${answers.needs_human.noul}`;
    for (const [k, v] of Object.entries(answers)) {
        if (v && typeof v === 'object' && v.noul != null) return `${k} noul: ${v.noul}`;
        if (v && typeof v === 'object' && v.choice) return `${k} choice: ${v.choice}`;
    }
    return inner.model ? `model ${inner.model}` : null;
}

/** Collapse duplicate turn_start rows (ingest re-runs); keep all guard events. */
export function dedupeLedgerRows(rows) {
    const sorted = [...rows].sort((a, b) =>
        String(a.created_at || a.createdAt).localeCompare(String(b.created_at || b.createdAt)),
    );
    const guards = sorted.filter((r) => (r.event_type || r.eventType) === 'pre_guard_shell');
    const turns = sorted.filter((r) => (r.event_type || r.eventType) !== 'pre_guard_shell');
    const latestTurn = turns.length ? turns[turns.length - 1] : null;
    const out = [];
    if (latestTurn) out.push(latestTurn);
    out.push(...guards);
    const droppedTurns = turns.length > 1 ? turns.length - 1 : 0;
    return { rows: out, droppedTurns, totalTurnRows: turns.length };
}

/**
 * Design-aligned path for one ledger row (facade + layer stack, not bare policy label).
 * @param {object} row
 * @param {{ userQuery?: string }} [meta]
 */
export function buildDesignAlignedGraph(row, meta = {}) {
    const eventType = row.event_type || row.eventType || 'turn_start';
    const jevMode = row.jev_mode || row.jevMode || 'off';
    const verdict = row.enforced_verdict || row.enforcedVerdict || '—';
    const winner = row.resolver_winner || row.resolverWinner || '';
    const ambPol = row.ambiguous_policy || row.ambiguousPolicy || 'hil_only';
    const candidates = safeJson(row.l0_candidates_json || row.l0CandidatesJson) || [];
    const jevNote = jevHint(row.jev_response_json || row.jevResponseJson);
    const query = String(meta.userQuery || '').slice(0, 60);

    const nodes = [];
    const edges = [];
    let ei = 0;
    const highlights = [];
    const N = (id, data) => {
        nodes.push({ id, data });
        return id;
    };
    const E = (a, b) => {
        edges.push({ id: `e${ei++}`, source: a, target: b });
    };

    const turn = N('turn', {
        kind: 'context',
        layer: 'IDE',
        label: query ? `Turn · ${query}…` : 'Turn boundary',
        tip: 'Cursor/Antigravity agent loop · user prompt (design §6)',
    });
    const facade = N('facade', {
        kind: 'facade',
        layer: 'Facade',
        label: 'Decision Facade · decide()',
        tip: `Event: ${eventType} · tools/harness/decision-facade`,
    });
    E(turn, facade);

    const policy = N('policy', {
        kind: 'policy',
        layer: 'Facade',
        label: 'Policy loader',
        tip: `.harness/decision-policy.json\njev.mode=${jevMode}\non_ambiguous=${ambPol}`,
    });
    E(facade, policy);

    if (eventType === 'pre_guard_shell') {
        const l1 = N('l1', {
            kind: 'stage',
            layer: 'L1',
            label: 'L1 · guard.shell fuzzy',
            tip: 'Heuristic shell band allow/deny/ask (design §7)',
        });
        E(policy, l1);
        let prev = l1;
        if (jevMode === 'off') {
            const skip = N('jev-skip', { kind: 'skip', layer: 'L2', label: 'L2 Jev skipped', tip: 'jev.mode=off' });
            E(prev, skip);
            prev = skip;
        } else {
            const jev = N('jev', {
                kind: 'jev',
                layer: 'L2',
                label: `L2 · JevResolver (${jevMode})`,
                tip: jevNote || 'TypeSafe System One · guard.shell pack',
            });
            E(prev, jev);
            prev = jev;
        }
        const out = N('result', {
            kind: 'verdict',
            layer: 'Out',
            label: `DecisionResult · ${verdict}`,
            tip: `resolver_winner=${winner || '—'}`,
        });
        E(prev, out);
        highlights.push('result');
        return { nodes, edges, highlights };
    }

    const l0 = N('l0', {
        kind: 'stage',
        layer: 'L0',
        label: 'L0 · route-graph + overlap',
        tip: 'Deterministic: route-graph.json, rules/skills surfaces (design §2 L0)',
    });
    E(policy, l0);

    let prev = l0;
    if (candidates.length) {
        const top = candidates.slice(0, 4);
        const cand = N('cand', {
            kind: 'candidates',
            layer: 'L0',
            label: `scored ${candidates.length} candidate(s)`,
            tip: top.map((c) => `${c.id || c.ruleId || '?'} score=${c.score ?? '?'}`).join('\n'),
        });
        E(prev, cand);
        prev = cand;
    }

    const l1route = N('l1r', {
        kind: 'stage',
        layer: 'L1',
        label: 'L1 · checks / tie detect',
        tip: 'Conformance + ambiguity detection before paid S1',
    });
    E(prev, l1route);
    prev = l1route;

    const ambiguous =
        verdict === 'hil_only' ||
        verdict === 'ambiguous' ||
        String(winner).startsWith('ambiguity') ||
        winner === 'ambiguity_hil_only';

    if (jevMode === 'off') {
        const amb = N('amb', {
            kind: 'amb',
            layer: 'L1',
            label: ambiguous ? `ambiguous → ${ambPol}` : 'L0 winner (no Jev)',
            tip: ambiguous ? 'No Jev HTTP · hil_only / safe_default (design §4)' : 'Clear L0 pick',
        });
        E(prev, amb);
        prev = amb;
    } else {
        const jev = N('jev', {
            kind: 'jev',
            layer: 'L2',
            label: `L2 · JevResolver (${jevMode})`,
            tip: jevNote || `route.tie_break pack · enforce=${jevMode === 'active'}`,
        });
        E(prev, jev);
        prev = jev;
    }

    if (verdict === 'route_l3' || String(verdict).startsWith('l3_')) {
        const l3 = N('l3', {
            kind: 'stage',
            layer: 'L3',
            label: 'L3 · Flash JSON fallback',
            tip: 'DeepSeek flash · optional (design §2 L3)',
        });
        E(prev, l3);
        prev = l3;
    }

    const s2 = N('s2', {
        kind: 'skip',
        layer: 'L4',
        label: 'L4 System 2 · not used',
        tip: 'Pro/Flash Brain not invoked for this route pick',
    });
    E(prev, s2);
    prev = s2;

    const out = N('result', {
        kind: 'verdict',
        layer: 'Out',
        label: `DecisionResult · ${verdict}`,
        tip: `resolver_winner=${winner || '—'} · p=${row.top_probability ?? row.topProbability ?? '—'}`,
    });
    E(prev, out);
    highlights.push('result');
    return { nodes, edges, highlights };
}

/** @deprecated use buildDesignAlignedGraph — kept for tests */
export function buildPathGraphForLedgerRow(row) {
    return buildDesignAlignedGraph(row);
}

/** One graph per request: latest turn_start + optional guard chain (design §6–7). */
export function buildPathGraphForRequest(ledgerRows, meta = {}) {
    const { rows, droppedTurns } = dedupeLedgerRows(ledgerRows);
    if (!rows.length) return { graph: null, droppedTurns, displayRows: [] };

    const nodes = [];
    const edges = [];
    let ei = 0;
    const highlights = [];
    const N = (id, data) => {
        nodes.push({ id, data });
        return id;
    };
    const E = (a, b) => {
        edges.push({ id: `e${ei++}`, source: a, target: b });
    };

    let chainTail = null;
    for (let i = 0; i < rows.length; i++) {
        const g = buildDesignAlignedGraph(rows[i], i === 0 ? meta : {});
        const prefix = rows[i].event_type === 'pre_guard_shell' ? `g${i}:` : 'route:';
        const idMap = new Map();
        for (const n of g.nodes) {
            const nid = prefix + n.id;
            idMap.set(n.id, nid);
            const label =
                rows[i].event_type === 'pre_guard_shell' && n.id === 'turn'
                    ? 'Shell hook · pre_guard'
                    : n.data.label;
            N(nid, { ...n.data, label });
        }
        for (const e of g.edges) E(idMap.get(e.source), idMap.get(e.target));
        for (const h of g.highlights) highlights.push(prefix + h);
        const head = idMap.get('turn');
        if (chainTail && head) E(chainTail, head);
        chainTail = idMap.get('result') || head;
    }
    return {
        graph: { nodes, edges, highlights },
        droppedTurns,
        displayRows: rows,
    };
}

function mapLedgerRow(row) {
    return {
        id: row.id,
        eventType: row.event_type,
        jevMode: row.jev_mode,
        resolverWinner: row.resolver_winner,
        enforcedVerdict: row.enforced_verdict,
        ambiguousPolicy: row.ambiguous_policy,
        topProbability: row.top_probability,
        latencyMsL0: row.latency_ms_l0,
        latencyMsJev: row.latency_ms_jev,
        flashFallbackUsed: !!row.flash_fallback_used,
        createdAt: row.created_at,
        l0Candidates: safeJson(row.l0_candidates_json),
        jevSummary: jevHint(row.jev_response_json),
    };
}

function attachEsoToPathGraph(pathGraph, esoLedgerRow) {
    if (!esoLedgerRow || !pathGraph?.graph) return pathGraph;
    const g = pathGraph.graph;
    const esoNode = `eso:${esoLedgerRow.id}`;
    const level = esoLedgerRow.enforced_verdict || 'partial';
    g.nodes.push({
        id: esoNode,
        data: {
            kind: 'eso',
            layer: 'ESO',
            label: `ESO · ${level}`,
            tip: `evidence_sufficiency · score=${esoLedgerRow.top_probability ?? '—'}`,
        },
    });
    const verdicts = g.nodes.filter((n) => n.data?.kind === 'verdict');
    const tail = verdicts.length ? verdicts[verdicts.length - 1].id : null;
    if (tail) {
        g.edges.push({ id: `e-eso-${esoLedgerRow.id}`, source: tail, target: esoNode });
    }
    if (g.highlights) g.highlights.push(esoNode);
    return pathGraph;
}

/**
 * @param {import('@mu/harness-foundation').SqliteDb} db
 * @param {string} projectId
 * @param {string} requestId
 * @param {{ events?: object[], tools?: object[], files?: object[], attached?: object[] }} [observe]
 */
export function loadDecisionFlowForRequest(db, projectId, requestId, observe = {}) {
    const request = db.get(
        `SELECT id, conversation_id, boundary_index, user_query, started_at, generation_id
         FROM request WHERE id = ? AND project_id = ?`,
        [requestId, projectId],
    );
    if (!request) return null;

    const ledger = db.all(
        `SELECT * FROM decision_ledger WHERE project_id = ? AND request_id = ? ORDER BY created_at ASC`,
        [projectId, requestId],
    );
    const esoLedgerRow = ledger.find((r) => r.event_type === 'evidence_sufficiency') || null;
    const facadeLedger = ledger.filter((r) => r.event_type !== 'evidence_sufficiency');
    const mcp = db.get(`SELECT * FROM mcp_call_stats WHERE request_id = ?`, [requestId]);

    let pathBundle = buildPathGraphForRequest(facadeLedger, {
        userQuery: request.user_query,
    });
    pathBundle = attachEsoToPathGraph(pathBundle, esoLedgerRow);
    const { graph, droppedTurns, displayRows } = pathBundle;
    const observedFallback =
        displayRows.length === 0
            ? computeObservedActivityHighlight({
                  events: observe.events,
                  tools: observe.tools,
                  files: observe.files,
                  attached: observe.attached,
                  hasIngest: true,
              })
            : null;
    const designGraph = buildDesignViewGraph(displayRows, { userQuery: request.user_query }, observedFallback);
    const sequenceGraph = buildSequenceViewGraph(displayRows);

    return {
        request: {
            id: request.id,
            conversationId: request.conversation_id,
            boundaryIndex: request.boundary_index,
            userQuery: request.user_query,
            startedAt: request.started_at,
            generationId: request.generation_id,
        },
        decisions: facadeLedger.map(mapLedgerRow),
        decisionsDisplay: displayRows.map(mapLedgerRow),
        evidenceSufficiency: esoLedgerRow
            ? {
                  ...mapLedgerRow(esoLedgerRow),
                  summary: formatEsoSummary(parseBundleFromLedgerRow(esoLedgerRow)),
              }
            : null,
        ingestNote:
            droppedTurns > 0
                ? `${droppedTurns} older turn_start row(s) hidden — ingest re-ran while files were still accumulating (same turn, new touchedPaths).`
                : displayRows.length === 0 && observedFallback?.nodes?.size
                  ? 'No decision_ledger row — green path from transcript tools + ingest spine (hooks not linked).'
                  : displayRows.length === 0
                    ? 'No decision_ledger row — provision consumer hooks + sidecar for turn_start highlight.'
                    : null,
        graph,
        designGraph,
        sequenceGraph,
        mcpStats: mcp
            ? {
                  flashBrain: mcp.flash_brain_count,
                  flashExecutor: mcp.flash_executor_count,
                  pro: mcp.pro_count,
                  jev: mcp.jev_count,
              }
            : null,
        designRef: 'document/harness/02.harness-eso/19.diagrams-mermaid.md §V5 · §V3 · Phase A facade · policy',
    };
}

export function loadDecisionFlowForConversation(db, projectId, conversationId, limit = 80) {
    const requests = db.all(
        `SELECT id, boundary_index, user_query, started_at
         FROM request WHERE project_id = ? AND conversation_id = ?
         ORDER BY boundary_index ASC LIMIT ?`,
        [projectId, conversationId, limit],
    );
    const items = [];
    for (const r of requests) {
        const flow = loadDecisionFlowForRequest(db, projectId, r.id);
        if (flow) items.push(flow);
    }
    const withLedger = items.filter((x) => x.decisions.length > 0);
    return {
        conversationId,
        turnCount: requests.length,
        turnsWithDecisions: withLedger.length,
        items: withLedger.length ? withLedger : items.slice(0, 20),
        designRef: 'document/harness/02.harness-eso/19.diagrams-mermaid.md',
    };
}

export function verdictChipClass(verdict) {
    const v = String(verdict || '');
    if (v.includes('jev') && v.includes('deny')) return 'bad';
    if (v.includes('deny') || v === 'hil_only') return 'warn';
    if (v.startsWith('route_') || v.includes('allow')) return 'ok';
    if (v.includes('shadow')) return 'dim';
    return '';
}
