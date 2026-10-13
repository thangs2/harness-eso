import { useEffect, useId, useRef } from 'react';
import type { FlowGraphDocument } from '@/shared/graph/layoutFlowGraph';
import { layoutForMode, toG6GraphData, type G6GraphMode } from './g6FlowData';

export function G6GraphPanel({
    graph,
    mode,
    height = 440,
    emptyLabel = 'No graph data',
    legend,
    title,
}: {
    graph: FlowGraphDocument | null | undefined;
    mode: G6GraphMode;
    height?: number;
    emptyLabel?: string;
    legend?: string;
    title?: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const instanceId = useId();
    const legendText = legend ?? graph?.legend;

    useEffect(() => {
        const el = containerRef.current;
        if (!el || !graph?.nodes?.length) return;

        let graphInst: { destroy: () => void } | null = null;
        let cancelled = false;

        (async () => {
            const { Graph } = await import('@antv/g6');
            if (cancelled || !containerRef.current) return;

            const data = toG6GraphData(graph);
            const g = new Graph({
                container: el,
                width: el.clientWidth || 800,
                height,
                autoFit: 'view',
                padding: [16, 16, 16, 16],
                data,
                layout: layoutForMode(mode),
                node: {
                    type: 'rect',
                    style: {
                        size: [152, 38],
                        radius: 6,
                        labelText: (d: { data?: { label?: string } }) => d.data?.label ?? '',
                        labelFontSize: 10,
                        labelFill: '#e2e8f0',
                        fill: (d: { data?: { active?: boolean } }) =>
                            d.data?.active ? '#1a3d2e' : '#252b36',
                        stroke: (d: { data?: { active?: boolean } }) =>
                            d.data?.active ? '#4ec97a' : '#3d4654',
                        lineWidth: (d: { data?: { active?: boolean } }) => (d.data?.active ? 2 : 1),
                        opacity: (d: { data?: { active?: boolean; kind?: string } }) =>
                            d.data?.kind === 'blueprint' && !d.data?.active ? 0.5 : 1,
                    },
                },
                edge: {
                    type: 'polyline',
                    style: {
                        stroke: (d: { data?: { active?: boolean } }) =>
                            d.data?.active ? '#4ec97a' : '#4b5563',
                        lineWidth: (d: { data?: { active?: boolean } }) => (d.data?.active ? 2 : 1),
                        endArrow: true,
                        labelText: (d: { data?: { label?: string } }) => d.data?.label ?? '',
                        labelFontSize: 9,
                        labelFill: '#94a3b8',
                    },
                },
                combo: {
                    type: 'rect',
                    style: {
                        radius: 8,
                        fill: '#0f121a',
                        stroke: '#2a3142',
                        labelText: (d: { data?: { label?: string } }) => d.data?.label ?? '',
                        labelFill: '#94a3b8',
                        labelFontSize: 11,
                        labelPlacement: 'top',
                        labelOffsetY: -6,
                    },
                },
                behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
            });

            await g.render();
            graphInst = g;
        })().catch(() => {
            /* G6 load/render failure — container stays empty */
        });

        return () => {
            cancelled = true;
            graphInst?.destroy();
            graphInst = null;
        };
    }, [graph, mode, height, instanceId]);

    if (!graph?.nodes?.length) {
        return <p className="obs-sub m-0">{emptyLabel}</p>;
    }

    return (
        <div className="g6-graph-panel">
            {title ? <p className="obs-sub m-0 mb-2">{title}</p> : null}
            {legendText ? <p className="flow-graph-legend m-0 mb-2">{legendText}</p> : null}
            <div ref={containerRef} className="g6-graph-host" style={{ height }} />
        </div>
    );
}
