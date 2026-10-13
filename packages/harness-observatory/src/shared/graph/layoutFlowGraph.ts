import {
    layoutLayeredGraph,
    type FlowEdge,
    type FlowNode,
    type LayoutNode,
} from './layoutLayered';

export interface FlowCombo {
    id: string;
    data?: { label?: string };
}

export interface FlowGraphDocument {
    nodes?: FlowNode[];
    edges?: FlowEdge[];
    combos?: FlowCombo[];
    highlights?: string[];
    width?: number;
    height?: number;
    legend?: string;
    title?: string;
}

export interface LaidOutEdge extends FlowEdge {
    data?: Record<string, unknown>;
    label?: string;
    active?: boolean;
    returnEdge?: boolean;
}

export interface FlowGraphLayout {
    nodes: LayoutNode[];
    edges: LaidOutEdge[];
    width: number;
    height: number;
    comboBands?: Array<{ id: string; label: string; y: number; h: number }>;
}

function nodeCombo(n: FlowNode): string | undefined {
    const raw = n as FlowNode & { combo?: string };
    return raw.combo ?? (n.data?.combo as string | undefined);
}

function hasFixedPositions(nodes: FlowNode[]): boolean {
    return nodes.some((n) => {
        const s = (n as FlowNode & { style?: { x?: number; y?: number } }).style;
        return s?.x != null && s?.y != null;
    });
}

function collectActiveSets(graph: FlowGraphDocument) {
    const highlightIds = new Set(graph.highlights ?? []);
    return {
        nodeActive(n: FlowNode) {
            return highlightIds.has(n.id) || n.data?.active === true;
        },
        edgeActive(e: FlowEdge & { data?: Record<string, unknown> }) {
            const id = e.id ?? `${e.source}--${e.target}`;
            return highlightIds.has(id) || e.data?.active === true;
        },
    };
}

function layoutFixedSequence(graph: FlowGraphDocument): FlowGraphLayout {
    const nodes = graph.nodes ?? [];
    const edges = graph.edges ?? [];
    const { nodeActive, edgeActive } = collectActiveSets(graph);

    const layoutNodes: LayoutNode[] = nodes.map((n) => {
        const style = (n as FlowNode & { style?: { x?: number; y?: number } }).style ?? {};
        const kind = String(n.data?.kind ?? 'node');
        const w = kind === 'lifeline' ? 72 : kind === 'port' ? 8 : 120;
        const h = kind === 'port' ? 8 : 32;
        const active = nodeActive(n);
        return {
            ...n,
            x: (style.x ?? 0) - (kind === 'lifeline' ? 0 : w / 2),
            y: style.y ?? 0,
            w,
            h,
            data: { ...n.data, active },
        };
    });

    const laidEdges: LaidOutEdge[] = edges.map((e) => ({
        ...e,
        active: edgeActive(e as LaidOutEdge),
        label: (e as LaidOutEdge).data?.label as string | undefined,
        returnEdge: (e as LaidOutEdge).data?.return === true,
    }));

    return {
        nodes: layoutNodes,
        edges: laidEdges,
        width: graph.width ?? 900,
        height: graph.height ?? 420,
    };
}

function layoutByCombos(graph: FlowGraphDocument): FlowGraphLayout {
    const combos = graph.combos ?? [];
    const allNodes = graph.nodes ?? [];
    const allEdges = graph.edges ?? [];
    const { nodeActive, edgeActive } = collectActiveSets(graph);

    const layoutNodes: LayoutNode[] = [];
    const laidEdges: LaidOutEdge[] = [];
    const comboBands: FlowGraphLayout['comboBands'] = [];

    let yCursor = 16;
    const COMBO_PAD = 20;
    const COMBO_GAP = 28;
    let maxWidth = 640;

    for (const combo of combos) {
        const members = allNodes.filter((n) => nodeCombo(n) === combo.id);
        if (!members.length) continue;

        const memberIds = new Set(members.map((n) => n.id));
        const innerEdges = allEdges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target));
        const highlightIds = new Set(members.filter(nodeActive).map((n) => n.id));
        const inner = layoutLayeredGraph(members, innerEdges, { highlightIds });

        const bandH = inner.height + COMBO_PAD * 2 + 22;
        comboBands.push({
            id: combo.id,
            label: combo.data?.label ?? combo.id,
            y: yCursor,
            h: bandH,
        });

        const offsetX = COMBO_PAD + 12;
        const offsetY = yCursor + COMBO_PAD + 22;

        for (const n of inner.nodes) {
            layoutNodes.push({
                ...n,
                x: n.x + offsetX,
                y: n.y + offsetY,
                data: {
                    ...n.data,
                    active: nodeActive(n),
                },
            });
        }

        for (const e of innerEdges) {
            laidEdges.push({
                ...e,
                active: edgeActive(e as LaidOutEdge),
            });
        }

        maxWidth = Math.max(maxWidth, inner.width + offsetX * 2);
        yCursor += bandH + COMBO_GAP;
    }

    // Orphan nodes (no combo)
    const orphans = allNodes.filter((n) => !nodeCombo(n));
    if (orphans.length) {
        const orphanEdges = allEdges.filter(
            (e) => orphans.some((n) => n.id === e.source) && orphans.some((n) => n.id === e.target),
        );
        const inner = layoutLayeredGraph(orphans, orphanEdges);
        for (const n of inner.nodes) {
            layoutNodes.push({
                ...n,
                x: n.x + 16,
                y: n.y + yCursor,
                data: { ...n.data, active: nodeActive(n) },
            });
        }
        for (const e of orphanEdges) {
            laidEdges.push({ ...e, active: edgeActive(e as LaidOutEdge) });
        }
        yCursor += inner.height + COMBO_GAP;
        maxWidth = Math.max(maxWidth, inner.width + 32);
    }

    return {
        nodes: layoutNodes,
        edges: laidEdges,
        width: maxWidth,
        height: yCursor + 16,
        comboBands,
    };
}

export function layoutFlowGraph(graph: FlowGraphDocument | null | undefined): FlowGraphLayout | null {
    if (!graph?.nodes?.length) return null;

    if (graph.width && graph.height && hasFixedPositions(graph.nodes)) {
        return layoutFixedSequence(graph);
    }

    if (graph.combos?.length) {
        return layoutByCombos(graph);
    }

    const { nodeActive, edgeActive } = collectActiveSets(graph);
    const highlightIds = new Set(graph.nodes.filter(nodeActive).map((n) => n.id));
    const laid = layoutLayeredGraph(graph.nodes, graph.edges ?? [], { highlightIds });
    return {
        nodes: laid.nodes.map((n) => ({
            ...n,
            data: { ...n.data, active: nodeActive(n) },
        })),
        edges: (graph.edges ?? []).map((e) => ({
            ...e,
            active: edgeActive(e as LaidOutEdge),
        })),
        width: laid.width,
        height: laid.height,
    };
}
