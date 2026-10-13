import { useMemo, useState } from 'react';
import type { DecisionFlowVm } from '@/shared/api/types';
import { FlowGraphSvg } from '@/features/graph/FlowGraphSvg';
import { PromaxBlueprintGrid } from '@/features/graph/PromaxG6Panels';
import { Panel } from '@/ui/Panel';

type DesignTab = 'grid' | 'blueprint';

export function DecisionFlowView({ flow }: { flow: DecisionFlowVm }) {
    const [tab, setTab] = useState<DesignTab>('grid');
    const decisions = flow.decisionsDisplay ?? flow.decisions ?? [];
    const designGraph = flow.designGraph;

    const meta = useMemo(() => {
        const display = decisions.length;
        const raw = flow.decisions?.length ?? 0;
        const parts = [
            display ? `${display} path event(s) shown` : 'no decision_ledger row yet',
            raw > display
                ? `${raw} raw ledger row(s) (${raw - display} duplicate turn_start collapsed)`
                : '',
            flow.ingestNote || '',
            flow.mcpStats
                ? `MCP pro ${flow.mcpStats.pro} · flash ${flow.mcpStats.flashBrain}/${flow.mcpStats.flashExecutor} · jev ${flow.mcpStats.jev}`
                : '',
            designGraph?.legend || '19.diagrams-mermaid.md §1–4 panels; green = this request path',
        ].filter(Boolean);
        return parts.join(' · ');
    }, [decisions.length, flow.decisions?.length, flow.ingestNote, flow.mcpStats, designGraph?.legend]);

    return (
        <Panel title="Decision — this request" className="obs-panel--decision">
            <p className="obs-sub m-0 mb-2">{meta}</p>

            <div className="flow-tabs mb-3">
                <button
                    type="button"
                    className={`obs-btn obs-btn--ghost flow-tab${tab === 'grid' ? ' flow-tab--on' : ''}`}
                    onClick={() => setTab('grid')}
                >
                    Design grid (G6)
                </button>
                <button
                    type="button"
                    className={`obs-btn obs-btn--ghost flow-tab${tab === 'blueprint' ? ' flow-tab--on' : ''}`}
                    onClick={() => setTab('blueprint')}
                >
                    Blueprint (SVG)
                </button>
            </div>

            {tab === 'blueprint' ? (
                <FlowGraphSvg
                    graph={designGraph ?? undefined}
                    emptyLabel="No blueprint data."
                    legend={designGraph?.legend}
                    title={designGraph?.title}
                />
            ) : (
                <PromaxBlueprintGrid designGraph={designGraph} />
            )}

            {flow.evidenceSufficiency && (
                <div className="mt-4 text-sm">
                    <strong>ESO</strong>
                    {flow.evidenceSufficiency.enforcedVerdict
                        ? ` · ${flow.evidenceSufficiency.enforcedVerdict}`
                        : null}
                    {flow.evidenceSufficiency.summary &&
                    typeof flow.evidenceSufficiency.summary === 'string' ? (
                        <p className="obs-sub m-0 mt-1">{flow.evidenceSufficiency.summary}</p>
                    ) : null}
                </div>
            )}

            {decisions.length > 0 && (
                <div className="obs-table-wrap mt-4">
                    <table className="obs-table obs-table--decision">
                        <thead>
                            <tr>
                                <th>Event</th>
                                <th>Jev</th>
                                <th>Verdict</th>
                                <th>Winner</th>
                                <th>Jev hint</th>
                                <th className="tabular-nums">l0/jev ms</th>
                            </tr>
                        </thead>
                        <tbody>
                            {decisions.map((d) => (
                                <tr key={d.id}>
                                    <td className="obs-mono">{d.eventType}</td>
                                    <td>{d.jevMode ?? '—'}</td>
                                    <td className="obs-mono">{d.enforcedVerdict ?? '—'}</td>
                                    <td className="obs-mono">{d.resolverWinner ?? '—'}</td>
                                    <td className="obs-sub">{d.jevSummary ?? '—'}</td>
                                    <td className="tabular-nums obs-sub">
                                        {(d as { latencyMsL0?: number }).latencyMsL0 ?? '—'} /{' '}
                                        {(d as { latencyMsJev?: number }).latencyMsJev ?? '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}
