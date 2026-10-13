/** Simple layered DAG layout for small operator graphs (no G6 dep). */

export interface FlowNode {
    id: string;
    combo?: string;
    style?: { x?: number; y?: number };
    data?: {
        label?: string;
        kind?: string;
        layer?: string;
        tip?: string;
        active?: boolean;
        combo?: string;
    };
}

export interface FlowEdge {
    id?: string;
    source: string;
    target: string;
    data?: Record<string, unknown>;
}

export interface LayoutNode extends FlowNode {
    x: number;
    y: number;
    w: number;
    h: number;
}

const NODE_W = 148;
const NODE_H = 40;
const GAP_X = 56;
const GAP_Y = 28;

export function layoutLayeredGraph(
    nodes: FlowNode[],
    edges: FlowEdge[],
    opts?: { highlightIds?: Set<string> },
): { nodes: LayoutNode[]; edges: FlowEdge[]; width: number; height: number } {
    if (!nodes.length) {
        return { nodes: [], edges, width: 320, height: 120 };
    }

    const idSet = new Set(nodes.map((n) => n.id));
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const id of idSet) {
        incoming.set(id, []);
        outgoing.set(id, []);
    }
    for (const e of edges) {
        if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
        incoming.get(e.target)!.push(e.source);
        outgoing.get(e.source)!.push(e.target);
    }

    // Shortest-path layering from roots; blueprint graphs may contain feedback edges (19 §V5/V3).
    const depth = new Map<string, number>();
    const roots = nodes.filter((n) => !incoming.get(n.id)?.length).map((n) => n.id);
    const startIds = roots.length ? roots : [nodes[0].id];
    const queue = [...startIds];
    for (const id of startIds) depth.set(id, 0);
    while (queue.length) {
        const id = queue.shift()!;
        const d = depth.get(id) ?? 0;
        for (const t of outgoing.get(id) || []) {
            if (depth.has(t)) continue;
            depth.set(t, d + 1);
            queue.push(t);
        }
    }
    for (const n of nodes) {
        if (!depth.has(n.id)) depth.set(n.id, 0);
    }

    const layers = new Map<number, FlowNode[]>();
    for (const n of nodes) {
        const d = depth.get(n.id) ?? 0;
        const row = layers.get(d);
        if (row) row.push(n);
        else layers.set(d, [n]);
    }

    const layoutNodes: LayoutNode[] = [];
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);
    let maxRow = 0;
    for (const d of layerKeys) {
        const row = layers.get(d)!;
        maxRow = Math.max(maxRow, row.length);
        row.forEach((n, i) => {
            layoutNodes.push({
                ...n,
                x: d * (NODE_W + GAP_X) + 24,
                y: i * (NODE_H + GAP_Y) + 24,
                w: NODE_W,
                h: NODE_H,
            });
        });
    }

    const width = layerKeys.length * (NODE_W + GAP_X) + 48;
    const height = maxRow * (NODE_H + GAP_Y) + 48;

    if (opts?.highlightIds) {
        for (const n of layoutNodes) {
            if (opts.highlightIds.has(n.id)) {
                (n as LayoutNode & { highlighted?: boolean }).highlighted = true;
            }
        }
    }

    return { nodes: layoutNodes, edges, width, height };
}
