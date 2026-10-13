import type { FlowGraphDocument } from '@/shared/graph/layoutFlowGraph';

export type G6GraphMode = 'path' | 'sequence' | 'combo' | 'trace';

export function toG6GraphData(doc: FlowGraphDocument | null | undefined) {
    const nodes =
        doc?.nodes?.map((n) => {
            const style = n.style;
            const active = n.data?.active === true;
            return {
                id: n.id,
                combo: n.combo,
                style:
                    style?.x != null && style?.y != null
                        ? { x: style.x, y: style.y }
                        : undefined,
                data: {
                    label: String(n.data?.label ?? n.id).slice(0, 64),
                    active,
                    kind: n.data?.kind,
                    layer: n.data?.layer,
                },
            };
        }) ?? [];

    const edges =
        doc?.edges?.map((e) => ({
            id: e.id ?? `${e.source}--${e.target}`,
            source: e.source,
            target: e.target,
            data: {
                active: e.data?.active === true,
                label: e.data?.label as string | undefined,
            },
        })) ?? [];

    const combos =
        doc?.combos?.map((c) => ({
            id: c.id,
            data: { label: c.data?.label ?? c.id },
        })) ?? [];

    return { nodes, edges, combos };
}

export function layoutForMode(mode: G6GraphMode) {
    if (mode === 'sequence') {
        return { type: 'preset' };
    }
    if (mode === 'combo') {
        return {
            type: 'combo-combined',
            comboPadding: 24,
            outerLayout: { type: 'dagre', rankdir: 'TB' },
            innerLayout: { type: 'dagre', rankdir: 'LR', nodesep: 12, ranksep: 36 },
        };
    }
    return { type: 'dagre', rankdir: 'LR', nodesep: 16, ranksep: 48 };
}
