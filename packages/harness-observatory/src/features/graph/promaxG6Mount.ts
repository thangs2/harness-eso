import type { FlowGraphVm } from '@/shared/api/types';
import { BLUEPRINT_CANVAS_PAD, blueprintBoard } from './blueprintLayout';
import {
    flowLabelFill,
    flowNodeFill,
    flowNodeSize,
    s1BlueprintNodeSize,
    type FlowNodeData,
} from './promaxFlowStyles';

type G6Graph = {
    destroy: () => void;
    render: () => Promise<void>;
    fitView: (options?: unknown) => void;
};

/** G6 v5 may pass custom fields on `data` or flattened on the datum. */
function nodePayload(nd: Record<string, unknown>): FlowNodeData {
    const bag = nd.data && typeof nd.data === 'object' ? nd.data : nd;
    return (bag ?? {}) as FlowNodeData;
}

function edgePayload(ed: Record<string, unknown>) {
    const bag = ed.data && typeof ed.data === 'object' ? ed.data : ed;
    return (bag ?? {}) as { active?: boolean; label?: string };
}

function isActiveNode(d: FlowNodeData): boolean {
    return d.active === true;
}

function blueprintNodeFill(d: FlowNodeData): string {
    if (isActiveNode(d)) return '#1a3d2e';
    if (d.kind === 'root' || d.kind === 'hub' || d.kind === 'rule' || d.kind === 'step') {
        return flowNodeFill(d);
    }
    return '#252b36';
}

function blueprintNodeStroke(d: FlowNodeData): string {
    if (isActiveNode(d)) return '#4ec97a';
    if (d.kind === 'root' || d.kind === 'hub' || d.kind === 'rule' || d.kind === 'step') {
        return '#0b0e14';
    }
    return '#3d4654';
}

function blueprintLabelFill(d: FlowNodeData): string {
    if (isActiveNode(d)) return '#d1fae5';
    if (d.kind === 'step') return flowLabelFill(d);
    if (d.kind === 'root' || d.kind === 'hub' || d.kind === 'rule') return flowLabelFill(d);
    return '#6b7280';
}

const PROMAX_TOOLTIP_STYLE = {
    '.tooltip': {
        backgroundColor: '#0d1118',
        border: '1px solid #2b3550',
        borderRadius: '6px',
        color: '#e2e8f0',
        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.7), 0 8px 10px -6px rgba(0, 0, 0, 0.7)',
        padding: '8px 12px',
        fontSize: '11px',
        lineHeight: '1.45',
        zIndex: 100,
        pointerEvents: 'none',
    },
};

function flowTip(items: unknown) {
    const list = Array.isArray(items) ? items : items ? [items] : [];
    const first = (list[0] as Record<string, unknown>) ?? {};
    const nd = nodePayload(first);
    const raw = nd.tip || nd.label || (first.id ? String(first.id) : '');
    if (!raw) return '';
    const text = String(raw).trim();
    const lines = text.split('\n');
    const header = lines[0] ?? '';
    const rest = lines.slice(1).join('\n');
    const safeHeader = header.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeRest = rest.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (lines.length > 1) {
        return `<div class="g6-tip"><div class="g6-tip-header">${safeHeader}</div><div class="g6-tip-body">${safeRest}</div></div>`;
    }
    return `<div class="g6-tip">${safeHeader}</div>`;
}

function toFlowData(graph: FlowGraphVm) {
    return {
        nodes: (graph.nodes ?? []).map((n) => ({
            id: n.id,
            combo: n.combo,
            data: { ...(n.data as FlowNodeData) },
        })),
        edges: (graph.edges ?? []).map((e) => ({
            id: e.id ?? `${e.source}-${e.target}`,
            source: e.source,
            target: e.target,
            data: { ...(e.data ?? {}) },
        })),
        combos: (graph.combos ?? []).map((c) => ({ id: c.id, data: { ...(c.data ?? {}) } })),
    };
}

/**
 * Step node height (`flowNodeSize` → 24) plus the flow layout's `nodesep` (12), which is the
 * vertical separation between two nodes in the same dagre rank. That 36px pitch is the real
 * per-step cost; the frame previously budgeted 28px, so a tall stage column was under-counted
 * and `fitView()` compensated by zooming out — the labels got smaller instead of the frame
 * getting taller.
 */
const STEP_PITCH_PX = 36;
/** Root + hub rows and the combo padding: not proportional to step count. */
const FLOW_CHROME_PX = 160;
/**
 * Floor for a short flow. MUST equal the `min-height` on `.promax-d-graph` /
 * `.g6-graph-host--flow` — CSS wins over the inline height, so a lower value here is silently
 * ignored and a higher one makes the frame taller than asked. 380 is the number the stylesheet
 * was already painting, so this only makes the code agree with what the operator sees.
 */
const FLOW_MIN_PX = 380;
const FLOW_MAX_PX = 800;

function flowGraphHeight(graph: FlowGraphVm): number {
    const nodes = graph.nodes ?? [];
    const comboIds = [...new Set(nodes.map((n) => n.combo).filter(Boolean))];
    const maxStageLeaves = Math.max(
        1,
        ...comboIds.map((cid) =>
            nodes.filter((n) => n.combo === cid && n.data?.kind === 'step').length,
        ),
    );
    return Math.max(
        FLOW_MIN_PX,
        Math.min(FLOW_MAX_PX, FLOW_CHROME_PX + maxStageLeaves * STEP_PITCH_PX),
    );
}

const PROMAX_COMBO_STYLE = {
    type: 'rect' as const,
    style: {
        padding: [14, 28, 14, 14] as [number, number, number, number],
        radius: 8,
        fill: '#0d1118',
        stroke: '#2b3550',
        lineWidth: 1,
        labelText: (c: { data?: { label?: string } }) => c.data?.label || '',
        labelFill: '#8b97ab',
        labelFontSize: 10,
        labelPlacement: 'left' as const,
        labelOffsetX: -4,
    },
};

const PROMAX_CANVAS = { padding: [16, 16, 16, 16] as [number, number, number, number] };

export async function mountPromaxFlowGraph(
    host: HTMLElement,
    graph: FlowGraphVm,
): Promise<G6Graph | null> {
    const { Graph } = await import('@antv/g6');
    const w = Math.max(240, Math.round(host.clientWidth || 640));
    const h = flowGraphHeight(graph);
    host.style.height = `${h}px`;

    const data = toFlowData(graph);
    const g = new Graph({
        container: host,
        width: w,
        height: h,
        autoResize: true,
        animation: false,
        padding: PROMAX_CANVAS.padding,
        data,
        combo: PROMAX_COMBO_STYLE,
        node: {
            type: 'rect',
            style: {
                size: (nd) => flowNodeSize(nodePayload(nd)),
                radius: 7,
                fill: (nd) => flowNodeFill(nodePayload(nd)),
                stroke: '#0b0e14',
                lineWidth: 1,
                labelText: (nd) => nodePayload(nd).label || String(nd.id ?? ''),
                labelFill: (nd) => flowLabelFill(nodePayload(nd)),
                labelFontSize: 10,
                labelFontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                labelPlacement: 'center',
                cursor: 'grab',
            },
        },
        edge: {
            type: 'cubic',
            style: {
                stroke: '#2b3550',
                lineWidth: 1,
                endArrow: true,
                endArrowSize: 6,
                strokeOpacity: 0.62,
            },
        },
        layout: {
            // Mirrors baplatform harness monitor: one LR dagre pass over the combos,
            // which is what produces the "rules it ran under, then what it called,
            // in order" reading. `combo-combined` (LR outer + TB inner) rearranged the
            // combos into a grid and broke parity with the reference pane.
            type: 'antv-dagre',
            rankdir: 'LR',
            ranksep: 88,
            nodesep: 12,
            comboPadding: 20,
        },
        behaviors: [
            'zoom-canvas',
            'drag-canvas',
            { type: 'drag-element', enable: true },
            { type: 'hover-activate', degree: 1 },
        ],
        plugins: [
            {
                type: 'tooltip',
                key: 'tip',
                getContent: (_e: unknown, items: unknown) => flowTip(items),
                style: PROMAX_TOOLTIP_STYLE,
            },
        ],
    });
    await g.render();
    try {
        g.fitView();
    } catch {
        /* ignore */
    }
    return g as G6Graph;
}

export async function mountPromaxBlueprintCombo(
    host: HTMLElement,
    nodes: FlowGraphVm['nodes'],
    edges: FlowGraphVm['edges'],
): Promise<G6Graph | null> {
    const list = nodes ?? [];
    if (!list.length) return null;

    const { Graph } = await import('@antv/g6');

    /*
     * Positions come from `blueprintBoard`, not from a G6 layout — see that module for why
     * `antv-dagre` could not be trusted with the top-down order of these panels. G6 only infers a
     * layout when `options.layout` is set, so leaving it out renders exactly the coordinates given
     * here.
     */
    const board = blueprintBoard(
        list.map((n) => ({
            id: n.id,
            label: typeof n.data?.label === 'string' ? n.data.label : undefined,
        })),
        (edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target })),
    );
    const positionOf = new Map(board.nodes.map((n) => [n.id, n]));

    const w = Math.max(280, Math.round(host.clientWidth || 640));
    const h = Math.max(280, Math.round(host.clientHeight || 320));

    const data = {
        nodes: list.map((n) => {
            const at = positionOf.get(n.id);
            return {
                id: n.id,
                data: {
                    label: n.data?.label,
                    tip: n.data?.tip,
                    active: n.data?.active === true,
                    kind: n.data?.kind,
                },
                // Explicit centre. `size` is repeated so G6 never re-measures the box.
                style: at ? { x: at.x, y: at.y, size: [at.w, at.h] as [number, number] } : {},
            };
        }),
        edges: (edges ?? []).map((e) => ({
            id: e.id ?? `${e.source}-${e.target}`,
            source: e.source,
            target: e.target,
            data: { active: e.data?.active === true },
        })),
    };

    const g = new Graph({
        container: host,
        width: w,
        height: h,
        autoResize: true,
        animation: false,
        padding: [BLUEPRINT_CANVAS_PAD, BLUEPRINT_CANVAS_PAD, BLUEPRINT_CANVAS_PAD, BLUEPRINT_CANVAS_PAD],
        data,
        node: {
            type: 'rect',
            style: {
                size: (nd) => s1BlueprintNodeSize(nodePayload(nd)),
                radius: 4,
                fill: (nd) => blueprintNodeFill(nodePayload(nd)),
                stroke: (nd) => blueprintNodeStroke(nodePayload(nd)),
                lineWidth: (nd) => (isActiveNode(nodePayload(nd)) ? 2.5 : 1),
                labelText: (nd) => nodePayload(nd).label || String(nd.id ?? ''),
                labelFill: (nd) => blueprintLabelFill(nodePayload(nd)),
                labelFontSize: 8,
                labelFontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                labelPlacement: 'center',
            },
        },
        edge: {
            type: 'cubic',
            style: {
                stroke: (ed) => (edgePayload(ed).active ? '#4ec97a' : '#2f3640'),
                lineWidth: (ed) => (edgePayload(ed).active ? 2.2 : 1),
                endArrow: true,
                endArrowSize: 5,
                strokeOpacity: (ed) => (edgePayload(ed).active ? 0.95 : 0.45),
            },
        },
        behaviors: ['zoom-canvas', 'drag-canvas', { type: 'drag-element', enable: true }],
        plugins: [
            {
                type: 'tooltip',
                key: 's1tip',
                getContent: (_e: unknown, items: unknown) => flowTip(items),
                style: PROMAX_TOOLTIP_STYLE,
            },
        ],
    });
    await g.render();
    try {
        g.fitView();
    } catch {
        /* ignore */
    }
    return g as G6Graph;
}

/** Full design / ESO topology — combos + blueprint active path colors. */
export async function mountPromaxDesignGraph(
    host: HTMLElement,
    graph: FlowGraphVm,
): Promise<G6Graph | null> {
    const { Graph } = await import('@antv/g6');
    const w = Math.max(320, Math.round(host.clientWidth || 900));
    const h = Math.max(420, Math.round(host.clientHeight || 480));
    host.style.height = `${h}px`;

    const data = toFlowData(graph);
    const g = new Graph({
        container: host,
        width: w,
        height: h,
        autoResize: true,
        animation: false,
        padding: PROMAX_CANVAS.padding,
        data,
        combo: PROMAX_COMBO_STYLE,
        node: {
            type: 'rect',
            style: {
                size: (nd) => {
                    const d = nodePayload(nd);
                    return d.kind === 'root' || d.kind === 'hub' || d.kind === 'step'
                        ? flowNodeSize(d)
                        : s1BlueprintNodeSize(d);
                },
                radius: 4,
                fill: (nd) => blueprintNodeFill(nodePayload(nd)),
                stroke: (nd) => blueprintNodeStroke(nodePayload(nd)),
                lineWidth: (nd) => (isActiveNode(nodePayload(nd)) ? 2.5 : 1),
                labelText: (nd) => nodePayload(nd).label || String(nd.id ?? ''),
                labelFill: (nd) => blueprintLabelFill(nodePayload(nd)),
                labelFontSize: 9,
                labelFontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                labelPlacement: 'center',
            },
        },
        edge: {
            type: 'cubic',
            style: {
                stroke: (ed) => (edgePayload(ed).active ? '#4ec97a' : '#2f3640'),
                lineWidth: (ed) => (edgePayload(ed).active ? 2.2 : 1),
                endArrow: true,
                endArrowSize: 5,
                strokeOpacity: (ed) => (edgePayload(ed).active ? 0.95 : 0.45),
                labelText: (ed) => edgePayload(ed).label || '',
                labelFill: '#8b97ab',
                labelFontSize: 8,
            },
        },
        layout: {
            // See mountPromaxBlueprintCombo: 'dagre' is not a registered G6 5.1.1 layout.
            type: 'antv-dagre',
            rankdir: 'LR',
            ranksep: 48,
            nodesep: 14,
            comboPadding: 20,
        },
        behaviors: ['zoom-canvas', 'drag-canvas', { type: 'drag-element', enable: true }],
        plugins: [
            {
                type: 'tooltip',
                key: 'design',
                getContent: (_e: unknown, items: unknown) => flowTip(items),
                style: PROMAX_TOOLTIP_STYLE,
            },
        ],
    });
    await g.render();
    try {
        g.fitView();
    } catch {
        /* ignore */
    }
    return g as G6Graph;
}
