import { useId, useMemo } from 'react';
import { layoutFlowGraph, type FlowGraphDocument } from '@/shared/graph/layoutFlowGraph';

export function FlowGraphSvg({
    graph,
    title,
    emptyLabel = 'No graph data',
    legend,
}: {
    graph: FlowGraphDocument | null | undefined;
    title?: string;
    emptyLabel?: string;
    legend?: string;
}) {
    const markerId = useId().replace(/:/g, '');
    const laid = useMemo(() => layoutFlowGraph(graph), [graph]);

    if (!laid) {
        return <p className="obs-sub m-0">{emptyLabel}</p>;
    }

    const legendText = legend ?? graph?.legend;

    return (
        <div className="flow-graph-wrap">
            {title ? <p className="obs-sub m-0 mb-2">{title}</p> : null}
            {legendText ? <p className="flow-graph-legend m-0 mb-2">{legendText}</p> : null}
            <svg
                className="flow-graph-svg"
                width={laid.width}
                height={laid.height}
                role="img"
                aria-label={title || graph?.title || 'Flow graph'}
            >
                <defs>
                    <marker
                        id={`flow-arrow-${markerId}`}
                        markerWidth="8"
                        markerHeight="8"
                        refX="6"
                        refY="3"
                        orient="auto"
                    >
                        <path d="M0,0 L6,3 L0,6 Z" fill="#8b97ab" />
                    </marker>
                    <marker
                        id={`flow-arrow-active-${markerId}`}
                        markerWidth="8"
                        markerHeight="8"
                        refX="6"
                        refY="3"
                        orient="auto"
                    >
                        <path d="M0,0 L6,3 L0,6 Z" fill="#4ec97a" />
                    </marker>
                </defs>

                {laid.comboBands?.map((band) => (
                    <g key={band.id}>
                        <rect
                            x={8}
                            y={band.y}
                            width={laid.width - 16}
                            height={band.h}
                            rx={8}
                            className="flow-combo-band"
                        />
                        <text x={16} y={band.y + 16} className="flow-combo-label">
                            {band.label}
                        </text>
                    </g>
                ))}

                {laid.edges.map((e, i) => {
                    const a = laid.nodes.find((n) => n.id === e.source);
                    const b = laid.nodes.find((n) => n.id === e.target);
                    if (!a || !b) return null;
                    const active = e.active;
                    const x1 = a.x + a.w / 2;
                    const y1 = a.y + a.h / 2;
                    const x2 = b.x + b.w / 2;
                    const y2 = b.y + b.h / 2;
                    const mid = (x1 + x2) / 2;
                    const stroke = active ? 'rgb(52, 211, 153)' : 'rgb(100, 116, 139)';
                    return (
                        <g key={e.id || `edge-${i}`}>
                            <path
                                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                                fill="none"
                                stroke={stroke}
                                strokeWidth={active ? 2.5 : 1.5}
                                strokeDasharray={e.returnEdge ? '4 3' : undefined}
                                markerEnd={`url(#${active ? `flow-arrow-active-${markerId}` : `flow-arrow-${markerId}`})`}
                            />
                            {e.label ? (
                                <text
                                    x={mid}
                                    y={(y1 + y2) / 2 - 4}
                                    className="flow-edge-label"
                                    textAnchor="middle"
                                >
                                    {e.label.length > 28 ? `${e.label.slice(0, 26)}…` : e.label}
                                </text>
                            ) : null}
                        </g>
                    );
                })}

                {laid.nodes.map((n) => {
                    const kind = String(n.data?.kind ?? 'node');
                    if (kind === 'port') return null;
                    const layer = String(n.data?.layer ?? '');
                    const label = String(n.data?.label || n.id).slice(0, 48);
                    const active = n.data?.active === true;
                    const dim = kind === 'blueprint' && !active;
                    return (
                        <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
                            <title>{String(n.data?.tip || `${kind} ${layer}`.trim())}</title>
                            <rect
                                width={n.w}
                                height={n.h}
                                rx={6}
                                className={`flow-node flow-node--${kind}${active ? ' flow-node--hi' : ''}${dim ? ' flow-node--dim' : ''}`}
                            />
                            {kind !== 'lifeline' ? (
                                <>
                                    {layer ? (
                                        <text x={8} y={14} className="flow-node-layer">
                                            {layer}
                                        </text>
                                    ) : null}
                                    <text x={8} y={layer ? 28 : 22} className="flow-node-label">
                                        {label}
                                    </text>
                                </>
                            ) : (
                                <text x={n.w / 2} y={20} className="flow-node-label" textAnchor="middle">
                                    {label}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}
