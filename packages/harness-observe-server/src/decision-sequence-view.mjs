/**
 * Design doc §6 (turn boundary) + §7 (pre_guard_shell) as swimlane sequence.
 * Gray blueprint + green highlight per ledger row.
 */

const LANES = [
    ['U', 'User'],
    ['A', 'Cursor Agent'],
    ['G', 'guard-shell'],
    ['H', 'Hook route'],
    ['I', 'harness ingest'],
    ['F', 'Decision Facade'],
    ['L0', 'L0 graphs'],
    ['L1', 'L1 checks'],
    ['J', 'Jev API'],
    ['DB', 'harness.db'],
    ['P', 'DeepSeek Pro'],
    ['X', 'DeepSeek Flash'],
];

const LANE_Y = new Map(LANES.map(([id], i) => [id, i]));
const COL_W = 92;
const LANE_H = 34;
const PAD_X = 56;
const PAD_Y = 28;

/** @typedef {{ id: string, from: string, to: string, col: number, label: string, return?: boolean, guard?: boolean }} SeqMsg */

/** Full §6/§7 message catalog (design reference). */
export function sequenceMessageCatalog() {
    /** @type {SeqMsg[]} */
    const msgs = [
        { id: 'm01', from: 'U', to: 'A', col: 1, label: 'prompt / continue' },
        { id: 'm02', from: 'A', to: 'H', col: 2, label: 'turn-start hook' },
        { id: 'm03', from: 'H', to: 'I', col: 3, label: 'append trace' },
        { id: 'm04', from: 'I', to: 'DB', col: 4, label: 'upsert live fields' },
        { id: 'm05', from: 'H', to: 'F', col: 5, label: 'decide turn_start' },
        { id: 'm06', from: 'F', to: 'DB', col: 6, label: 'read session / checks' },
        { id: 'm07', from: 'F', to: 'L0', col: 7, label: 'score route candidates' },
        { id: 'm08', from: 'L0', to: 'F', col: 8, label: 'candidates + scores', return: true },
        { id: 'm09', from: 'F', to: 'H', col: 9, label: 'RoutePackage · L0 win' },
        { id: 'm10', from: 'F', to: 'L1', col: 10, label: 'conformance on tie set' },
        { id: 'm11', from: 'L1', to: 'F', col: 11, label: 'L1 eliminates to one', return: true },
        { id: 'm12', from: 'F', to: 'H', col: 12, label: 'RoutePackage · L1 win' },
        { id: 'm13', from: 'F', to: 'J', col: 13, label: 'POST systemone' },
        { id: 'm14', from: 'J', to: 'F', col: 14, label: 'Choice / Noul probs', return: true },
        { id: 'm15', from: 'F', to: 'DB', col: 15, label: 'ledger shadow' },
        { id: 'm16', from: 'F', to: 'H', col: 16, label: 'RoutePackage (L0 policy)' },
        { id: 'm17', from: 'F', to: 'H', col: 17, label: 'RoutePackage · Jev winner' },
        { id: 'm18', from: 'F', to: 'H', col: 18, label: 'RoutePackage + confirm' },
        { id: 'm19', from: 'F', to: 'X', col: 19, label: 'L3 schema classify' },
        { id: 'm20', from: 'X', to: 'F', col: 20, label: 'JSON verdict', return: true },
        { id: 'm21', from: 'F', to: 'H', col: 21, label: 'HIL + conservative rules' },
        { id: 'm22', from: 'F', to: 'DB', col: 22, label: 'ledger enforce / ambiguous' },
        { id: 'm23', from: 'A', to: 'P', col: 23, label: 'ask_deepseek_pro (S2)' },
        { id: 'm24', from: 'A', to: 'X', col: 24, label: 'Flash executor' },
        // §7 guard
        { id: 'g01', from: 'A', to: 'G', col: 1, label: 'shell proposed', guard: true },
        { id: 'g02', from: 'G', to: 'F', col: 2, label: 'decide pre_guard_shell', guard: true },
        { id: 'g03', from: 'F', to: 'L1', col: 3, label: 'deny lists / fuzzy', guard: true },
        { id: 'g04', from: 'F', to: 'J', col: 4, label: 'guard.shell Jev', guard: true },
        { id: 'g05', from: 'J', to: 'F', col: 5, label: 'guard verdict', return: true, guard: true },
        { id: 'g06', from: 'G', to: 'A', col: 6, label: 'allow / deny', guard: true },
        { id: 'g07', from: 'F', to: 'DB', col: 7, label: 'ledger guard', guard: true },
    ];
    return msgs;
}

function lanePos(participant, col) {
    const yi = LANE_Y.get(participant) ?? 0;
    return { x: PAD_X + col * COL_W, y: PAD_Y + yi * LANE_H };
}

/**
 * @param {SeqMsg[]} messages
 * @param {Set<string>} activeIds
 */
export function buildSequenceGraph(messages, activeIds) {
    const combos = LANES.map(([id, label]) => ({
        id: `lane-${id}`,
        data: { label: `${id} · ${label}` },
    }));

    const nodes = [];
    const edges = [];

    for (const [id] of LANES) {
        const p = lanePos(id, 0);
        nodes.push({
            id: `life-${id}`,
            combo: `lane-${id}`,
            style: { x: p.x - 36, y: p.y },
            data: { label: id, kind: 'lifeline', active: false },
        });
    }

    for (const m of messages) {
        const fromP = lanePos(m.from, m.col);
        const toP = lanePos(m.to, m.col);
        const active = activeIds.has(m.id);
        const fromId = `${m.id}:from`;
        const toId = `${m.id}:to`;
        nodes.push({
            id: fromId,
            combo: `lane-${m.from}`,
            style: { x: fromP.x, y: fromP.y },
            data: { label: '', kind: 'port', active },
        });
        nodes.push({
            id: toId,
            combo: `lane-${m.to}`,
            style: { x: toP.x, y: toP.y },
            data: { label: '', kind: 'port', active },
        });
        edges.push({
            id: m.id,
            source: fromId,
            target: toId,
            data: {
                label: m.label,
                active,
                return: !!m.return,
                guard: !!m.guard,
            },
        });
    }

    const maxCol = Math.max(...messages.map((m) => m.col), 1);
    const width = PAD_X + (maxCol + 2) * COL_W;
    const height = PAD_Y + LANES.length * LANE_H + 24;

    return {
        combos,
        nodes,
        edges,
        width,
        height,
        title: '§6 Turn boundary · §7 pre_guard_shell (sequence)',
        legend: 'Gray lifelines + messages = design reference; green = messages this request took.',
    };
}

/**
 * @param {object} row
 * @returns {Set<string>}
 */
export function computeSequenceHighlightForRow(row) {
    const active = new Set();
    const eventType = row.event_type || row.eventType || 'turn_start';
    const jevMode = row.jev_mode || row.jevMode || 'off';
    const verdict = row.enforced_verdict || row.enforcedVerdict || '';
    const winner = row.resolver_winner || row.resolverWinner || '';
    const amb = row.ambiguous_policy || row.ambiguousPolicy || 'hil_only';
    const jevMs = row.latency_ms_jev || row.latencyMsJev || 0;
    const jevJson = row.jev_response_json || row.jevResponseJson;
    const usedJev = jevMode !== 'off' && (jevMs > 0 || jevJson);

    if (eventType === 'pre_guard_shell') {
        for (const id of ['g01', 'g02', 'g03', 'g07']) active.add(id);
        if (usedJev) active.add('g04').add('g05');
        active.add('g06');
        return active;
    }

    const spine = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08'];
    for (const id of spine) active.add(id);

    const l0Win =
        verdict === 'route_l0' ||
        winner === 'l0_resolver' ||
        (verdict.startsWith('route_') && !verdict.includes('jev') && !verdict.includes('l3') && !verdict.includes('hil'));
    const jevWin = verdict.includes('jev') || winner.includes('jev');
    const l3Win = verdict.includes('l3') || String(winner).includes('l3');
    const hil = verdict === 'hil_only' || winner.includes('ambiguity') || winner.includes('hil');

    if (l0Win && !hil && !jevWin) {
        active.add('m09');
        active.add('m22');
        return active;
    }

    active.add('m10');
    if (winner === 'l1_resolver' || verdict === 'route_l1') {
        active.add('m11').add('m12').add('m22');
        return active;
    }

    if (jevMode !== 'off' && (usedJev || hil)) {
        active.add('m13').add('m14');
        if (jevMode === 'shadow') {
            active.add('m15').add('m16');
        }
        if (jevMode === 'active' && jevWin) {
            active.add('m17').add('m22');
        }
        if (jevMode === 'active' && verdict.includes('confirm')) active.add('m18');
    }

    if (l3Win) {
        active.add('m19').add('m20').add('m22');
    }

    if (hil || winner.includes('ambiguity')) {
        active.add('m21').add('m22');
        if (jevMode === 'off') {
            /* spine only + L1 + HIL */
        }
    }

    if (!active.has('m22') && active.size > spine.length) active.add('m22');

    return active;
}

export function mergeSequenceHighlights(rows) {
    const out = new Set();
    for (const row of rows) {
        for (const id of computeSequenceHighlightForRow(row)) out.add(id);
    }
    return out;
}

/**
 * @param {object[]} displayRows — raw ledger rows
 */
export function buildSequenceViewGraph(displayRows) {
    const catalog = sequenceMessageCatalog();
    const isGuard = displayRows.some((r) => (r.event_type || r.eventType) === 'pre_guard_shell');
    const isTurn = displayRows.some((r) => (r.event_type || r.eventType) === 'turn_start');
    let messages = catalog;
    if (isGuard && !isTurn) messages = catalog.filter((m) => m.guard);
    else if (isTurn && !isGuard) messages = catalog.filter((m) => !m.guard);
    else if (isTurn && isGuard) messages = catalog;

    const active = mergeSequenceHighlights(displayRows);
    return buildSequenceGraph(messages, active);
}
