/**
 * Deterministic top-down placement for the four blueprint combo panels (§1–§4).
 *
 * These panels are not free-form diagrams: they are the SoT §V5/§V3 topology and their whole
 * value is that the operator reads them as a waterfall — developer prompt, host hooks, Phase A
 * facade, Phase B/C/D, then the observe plane. That reading is destroyed when the engine is free
 * to re-rank nodes.
 *
 * The panels used to be laid out by G6's `antv-dagre`. Two properties of that engine made the
 * order unpredictable:
 *
 *  1. `AntVDagreLayout` hard-codes `acyclicer: 'greedy'`. Every blueprint contains genuine
 *     feedback edges (Phase D → Phase B retry, EvidenceBundle → agent loop), so a cycle always
 *     exists and greedyFAS gets to choose which edges to cut. It cuts by node degree, not by
 *     intent, so it happily deletes the forward spine (`AG → T0`) instead of the loop it was
 *     meant to remove. The surviving DAG then has its sources at the bottom — §1 rendered with
 *     Phase D at the top and Phase A near the bottom, and the developer prompt *below* Phase C.
 *  2. Its default `ranker` is `tight-tree` / `network-simplex`, which minimise total edge length
 *     rather than following the DAG order, so even an unambiguous chain could come out shuffled.
 *
 * `ranker: 'longest-path'` is not a fix: the `longest-path` in this dagre fork measures rank from
 * the *sinks* (`rank = min(successor.rank) - minlen`), and the greedy FAS damage is already done
 * before ranking. Measuring showed the option changed nothing at all.
 *
 * So the order is computed here instead, using the rule the topology actually needs — DFS
 * cycle-breaking (see `rankCombo`, which reverses the edge that closes a cycle, so the retry and
 * inject edges become upward feedback rather than rank inversions) followed by longest-path
 * layering from the sources. Ranks are emitted top to bottom, and within a rank nodes keep their
 * blueprint declaration order, which places the main spine in a single straight column on the
 * left and fans the branches out to the right.
 */

import { s1BlueprintNodeSize } from './promaxFlowStyles';

/** Node height for a blueprint node — `s1BlueprintNodeSize` uses a flat 26. */
const BLUEPRINT_NODE_H = 26;
/** Vertical gap between two ranks. Tuned so a 10-rank combo still fits its panel height. */
const RANK_GAP = 40;
/** Horizontal gap between two nodes sharing a rank. */
const SIBLING_GAP = 14;
/** Inset from the board edge to the first/last node box. */
const BOARD_PAD = 18;
/** `padding` passed to the G6 graph in `mountPromaxBlueprintCombo`. */
export const BLUEPRINT_CANVAS_PAD = 16;

export type RankedNodes = {
    /** node id -> 0-based rank (row), top to bottom */
    rank: Map<string, number>;
    /** edge ids dagre will reverse; drawn pointing up */
    backEdges: Set<string>;
    /** number of rows */
    depth: number;
};

/** Edges arrive from the API with an optional id; `source->target` is the fallback key. */
type InputEdge = { id?: string; source: string; target: string };

const edgeKey = (e: InputEdge): string => e.id ?? `${e.source}->${e.target}`;

/**
 * Rank a combo: break cycles the way the topology intends, then take the longest path.
 *
 * @param nodes ids present in the combo
 * @param edges edges whose BOTH endpoints are in the combo
 */
export function rankCombo(
    nodes: Array<{ id: string }>,
    edges: InputEdge[],
): RankedNodes {
    const out = new Map<string, Array<{ key: string; target: string }>>();
    for (const n of nodes) out.set(n.id, []);
    for (const e of edges) out.get(e.source)?.push({ key: edgeKey(e), target: e.target });

    // Phase 1 — acyclic: an edge closing a cycle is the one to reverse.
    const state = new Map<string, 0 | 1 | 2>();
    const backEdges = new Set<string>();
    const visit = (id: string) => {
        state.set(id, 1);
        for (const e of out.get(id) ?? []) {
            const s = state.get(e.target) ?? 0;
            if (s === 1) backEdges.add(e.key);
            else if (s === 0) visit(e.target);
        }
        state.set(id, 2);
    };
    for (const n of nodes) if ((state.get(n.id) ?? 0) === 0) visit(n.id);

    // Phase 2 — longest path over the graph with those edges reversed.
    const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
    const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    for (const e of edges) {
        const [from, to] = backEdges.has(edgeKey(e)) ? [e.target, e.source] : [e.source, e.target];
        if (!adj.has(from) || !adj.has(to)) continue;
        adj.get(from)!.push(to);
        indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
    const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    while (queue.length) {
        const id = queue.shift()!;
        for (const t of adj.get(id) ?? []) {
            rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
            const d = (indeg.get(t) ?? 1) - 1;
            indeg.set(t, d);
            if (d === 0) queue.push(t);
        }
    }
    const depth = nodes.length ? Math.max(...rank.values()) + 1 : 0;
    return { rank, backEdges, depth };
}

export type BoardNode = {
    id: string;
    /** Node CENTRE, which is what G6 writes to `style.x` / `style.y`. */
    x: number;
    y: number;
    w: number;
    h: number;
    rank: number;
};

export type BlueprintBoard = {
    nodes: BoardNode[];
    /** Board size including `BOARD_PAD`, excluding the G6 canvas padding. */
    width: number;
    height: number;
    depth: number;
};

/**
 * Resolve every node of one combo to an explicit centre position.
 *
 * Positions are handed to G6 as `style.x` / `style.y` with **no** layout configured: G6 only
 * infers a layout when `options.layout` is set (`inferLayoutOptions` returns early otherwise), so
 * a graph without one renders the coordinates it was given. That is what makes the waterfall
 * above stable instead of engine-dependent.
 */
export function blueprintBoard(
    nodes: Array<{ id: string; label?: string }>,
    edges: InputEdge[],
): BlueprintBoard {
    if (!nodes.length) return { nodes: [], width: 0, height: 0, depth: 0 };

    const { rank, depth } = rankCombo(nodes, edges);

    // Group by rank, preserving blueprint declaration order inside each rank.
    const rows = new Map<number, Array<{ id: string; w: number }>>();
    for (const n of nodes) {
        const w = s1BlueprintNodeSize({ label: n.label ?? n.id })[0];
        const r = rank.get(n.id) ?? 0;
        const row = rows.get(r);
        if (row) row.push({ id: n.id, w });
        else rows.set(r, [{ id: n.id, w }]);
    }

    const rowWidth = (items: Array<{ w: number }>) =>
        items.reduce((sum, i) => sum + i.w, 0) + SIBLING_GAP * Math.max(0, items.length - 1);

    const boardWidth = Math.max(...[...rows.values()].map(rowWidth));
    const out: BoardNode[] = [];
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
        const items = rows.get(r)!;
        // Left-aligned, not centred: the spine keeps a single straight column and branches grow
        // to the right, so "step by step top-down" stays readable even on wide ranks.
        let x = BOARD_PAD;
        const y = BOARD_PAD + r * (BLUEPRINT_NODE_H + RANK_GAP) + BLUEPRINT_NODE_H / 2;
        for (const it of items) {
            out.push({ id: it.id, x: x + it.w / 2, y, w: it.w, h: BLUEPRINT_NODE_H, rank: r });
            x += it.w + SIBLING_GAP;
        }
    }

    return {
        nodes: out,
        width: boardWidth + BOARD_PAD * 2,
        height: boardHeight(depth),
        depth,
    };
}

/** Board height, including `BOARD_PAD` top and bottom, for a combo of `depth` ranks. */
export function boardHeight(depth: number): number {
    if (!depth) return 0;
    return depth * BLUEPRINT_NODE_H + (depth - 1) * RANK_GAP + BOARD_PAD * 2;
}

/**
 * Host height for a combo panel, in px.
 *
 * The canvas is sized from the same ranks the board is built from, so the graph is never taller
 * than its panel and `fitView()` has no reason to zoom out vertically. It previously undercounted
 * — it assumed dagre packed ranks `ranksep` apart, but `antv-dagre` adds `2 * ranksep` to every
 * node's height, so the real pitch was 70px against a budgeted 48px and §1 was drawn at ~0.55
 * scale, which puts an 8px label at ~4px on screen.
 */
export function comboCanvasHeight(
    nodes: Array<{ id: string }>,
    edges: InputEdge[],
    opts: { min?: number; max?: number; depth?: number } = {},
): number {
    const { min = 260, max = 760 } = opts;
    const depth = opts.depth ?? rankCombo(nodes, edges).depth;
    if (!depth) return min;
    const needed = boardHeight(depth) + BLUEPRINT_CANVAS_PAD * 2;
    return Math.max(min, Math.min(max, needed));
}
