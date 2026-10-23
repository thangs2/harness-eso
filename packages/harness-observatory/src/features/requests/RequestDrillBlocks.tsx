import { useMemo, useState } from 'react';
import type { DecisionFlowVm, FlowGraphVm, RequestDetailResponse } from '@/shared/api/types';
import { PromaxDesignGraphPanel, PromaxFlowGraphPanel } from '@/features/graph/PromaxG6Panels';
import { FlowGraphSvg } from '@/features/graph/FlowGraphSvg';
import { flowRulesByBucket, relPath } from '@/features/graph/promaxFlowDetail';
import { PromaxRuleBuckets } from '@/features/requests/PromaxFlowPane';
import { ExecutionWaterfall } from '@/features/requests/ExecutionWaterfall';
import { Badge } from '@/ui/Badge';
import { Panel } from '@/ui/Panel';
import { checkStatusTone } from '@/ui/statusTone';

export type DrillTabKey = 'waterfall' | 'topology' | 'decisions' | 'rules' | 'telemetry';

export interface RequestDrillBlocksProps {
    detail: RequestDetailResponse;
    activeTab?: DrillTabKey;
    onTabChange?: (tab: DrillTabKey) => void;
}

export function RequestDrillBlocks({ detail, activeTab: controlledTab, onTabChange }: RequestDrillBlocksProps) {
    const [internalTab, setInternalTab] = useState<DrillTabKey>('waterfall');
    const activeTab = controlledTab ?? internalTab;
    const handleTabClick = (tab: DrillTabKey) => {
        setInternalTab(tab);
        onTabChange?.(tab);
    };
    const [topologyView, setTopologyView] = useState<'flow' | 'blueprint' | 'eso'>('flow');

    const evidence = detail.evidence as Record<string, unknown> | undefined;
    const checks = (detail.checks as Array<{ checkId: string; status: string; detail?: string; heuristic?: boolean }>) ?? [];
    const llmCalls = (detail.llmCalls as Array<{
        callIndex?: number;
        kind?: string;
        toolCount?: number;
        toolNames?: string;
        emitChars?: number;
        textChars?: number;
        estTokens?: number;
        preview?: string;
    }>) ?? [];
    const flow = detail.decisionFlow as DecisionFlowVm | null | undefined;
    const decisions = flow?.decisionsDisplay ?? flow?.decisions ?? [];
    const events = (detail.events as Array<{ eventType?: string; tool?: string; path?: string; hookAt?: string; command?: string }>) ?? [];
    const routeEvents = events.filter((e) => /route/i.test(String(e.eventType || '')));
    const flowGraph = detail.flowGraph as FlowGraphVm | null | undefined;
    const designGraph = flow?.designGraph;
    const esoDesignGraph = evidence?.designGraph as FlowGraphVm | undefined;

    const rulesUsedCount = useMemo(() => {
        return flowRulesByBucket({
            attached: detail.attached,
            rules: detail.rules,
            rootPath: detail.callerRootPath,
        }).reduce((n, g) => n + g.items.length, 0);
    }, [detail.attached, detail.rules, detail.callerRootPath]);

    const totalStepsCount = useMemo(() => {
        return events.filter((e) => e.eventType === 'postToolUse' || e.tool).length;
    }, [events]);

    return (
        <section className="request-drill-section mt-4 space-y-4">
            {/* Top Navigation Tabs */}
            <div className="flex items-center justify-between border-b border-surface-border pb-px">
                <nav className="flex items-center gap-1 -mb-px" aria-label="Request details tabs">
                    <button
                        type="button"
                        onClick={() => handleTabClick('waterfall')}
                        className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                            activeTab === 'waterfall'
                                ? 'border-emerald-400 text-emerald-400'
                                : 'border-transparent text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        <span>Execution & Waterfall</span>
                        <span className="px-1.5 py-0.2 bg-emerald-500/10 text-emerald-400 rounded-full text-[10px] tabular-nums font-mono">
                            {totalStepsCount}
                        </span>
                    </button>

                    <button
                        type="button"
                        onClick={() => handleTabClick('topology')}
                        className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                            activeTab === 'topology'
                                ? 'border-sky-400 text-sky-400'
                                : 'border-transparent text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        <span>Graphs & Topology</span>
                        <span className="px-1.5 py-0.2 bg-sky-500/10 text-sky-400 rounded-full text-[10px] tabular-nums font-mono">
                            3
                        </span>
                    </button>

                    <button
                        type="button"
                        onClick={() => handleTabClick('decisions')}
                        className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                            activeTab === 'decisions'
                                ? 'border-purple-400 text-purple-400'
                                : 'border-transparent text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        <span>Governance & Decisions</span>
                        {decisions.length > 0 && (
                            <span className="px-1.5 py-0.2 bg-purple-500/10 text-purple-400 rounded-full text-[10px] tabular-nums font-mono">
                                {decisions.length}
                            </span>
                        )}
                    </button>

                    <button
                        type="button"
                        onClick={() => handleTabClick('rules')}
                        className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                            activeTab === 'rules'
                                ? 'border-amber-400 text-amber-400'
                                : 'border-transparent text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        <span>Rules & Context</span>
                        <span className="px-1.5 py-0.2 bg-amber-500/10 text-amber-400 rounded-full text-[10px] tabular-nums font-mono">
                            {rulesUsedCount}
                        </span>
                    </button>

                    <button
                        type="button"
                        onClick={() => handleTabClick('telemetry')}
                        className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                            activeTab === 'telemetry'
                                ? 'border-indigo-400 text-indigo-400'
                                : 'border-transparent text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        <span>Telemetry & Trace</span>
                        <span className="px-1.5 py-0.2 bg-indigo-500/10 text-indigo-400 rounded-full text-[10px] tabular-nums font-mono">
                            {events.length}
                        </span>
                    </button>
                </nav>
            </div>

            {/* TAB 1: Execution & Waterfall */}
            {activeTab === 'waterfall' && (
                <div className="tab-pane-waterfall animate-fade-in">
                    <ExecutionWaterfall detail={detail} />
                </div>
            )}

            {/* TAB 2: Visual Flow & Topology Graphs */}
            {activeTab === 'topology' && (
                <div className="tab-pane-topology space-y-4 animate-fade-in">
                    <div className="flex items-center justify-between bg-surface-card border border-surface-border p-3 rounded-xl">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 font-medium mr-2">Select Canvas:</span>
                            <button
                                type="button"
                                onClick={() => setTopologyView('flow')}
                                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                                    topologyView === 'flow'
                                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                                        : 'bg-surface-raised text-slate-400 hover:text-slate-200 border border-transparent'
                                }`}
                            >
                                Execution Flow (G6)
                            </button>
                            <button
                                type="button"
                                onClick={() => setTopologyView('blueprint')}
                                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                                    topologyView === 'blueprint'
                                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                                        : 'bg-surface-raised text-slate-400 hover:text-slate-200 border border-transparent'
                                }`}
                            >
                                Decision Blueprint (SVG)
                            </button>
                            {esoDesignGraph?.nodes?.length ? (
                                <button
                                    type="button"
                                    onClick={() => setTopologyView('eso')}
                                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                                        topologyView === 'eso'
                                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                                            : 'bg-surface-raised text-slate-400 hover:text-slate-200 border border-transparent'
                                    }`}
                                >
                                    ESO Topology (G6)
                                </button>
                            ) : null}
                        </div>

                        <span className="text-[11px] text-slate-500">
                            Pan: click & drag · Zoom: scroll
                        </span>
                    </div>

                    {/* Active Canvas Display */}
                    <div className="bg-surface-card border border-surface-border rounded-xl p-4 shadow-sm min-h-[480px]">
                        {topologyView === 'flow' && (
                            <div>
                                <div className="mb-3 text-xs text-slate-400 flex items-center justify-between">
                                    <span>Staged execution graph showing rules attached, inspect tools, and edits.</span>
                                    {flowGraph?.nodes?.length ? (
                                        <Badge tone="neutral">{flowGraph.nodes.length} nodes</Badge>
                                    ) : null}
                                </div>
                                {flowGraph?.nodes?.length ? (
                                    <PromaxFlowGraphPanel graph={flowGraph} />
                                ) : (
                                    <div className="py-16 text-center text-slate-500 text-xs font-mono">
                                        No graph nodes recorded for this turn.
                                    </div>
                                )}
                            </div>
                        )}

                        {topologyView === 'blueprint' && (
                            <div>
                                <div className="mb-3 text-xs text-slate-400 flex items-center justify-between">
                                    <span>Decision path blueprint with L0/Jev state machine transitions.</span>
                                    {designGraph?.title ? (
                                        <span className="text-slate-400 font-mono text-[11px]">{designGraph.title}</span>
                                    ) : null}
                                </div>
                                <FlowGraphSvg
                                    graph={designGraph ?? undefined}
                                    emptyLabel="No blueprint data recorded."
                                    legend={designGraph?.legend}
                                    title={designGraph?.title}
                                />
                            </div>
                        )}

                        {topologyView === 'eso' && esoDesignGraph && (
                            <div>
                                <div className="mb-3 text-xs text-slate-400 flex items-center justify-between">
                                    <span>ESO System Topology (§V11 preflight vs ingest · §V12 cognition tiers · §V6 data plane).</span>
                                    <Badge tone="ok">ESO Active</Badge>
                                </div>
                                <PromaxDesignGraphPanel
                                    graph={esoDesignGraph}
                                    legend={esoDesignGraph.legend}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* TAB 3: Governance & Decisions */}
            {activeTab === 'decisions' && (
                <div className="tab-pane-decisions space-y-4 animate-fade-in">
                    {/* Decision Ledger */}
                    <Panel title="Decision Ledger" lede="L0 heuristic and Jev fast-facade routing events" accent="#c084fc">
                        {decisions.length === 0 ? (
                            <p className="text-xs text-slate-500 m-0">No decision events recorded for this turn.</p>
                        ) : (
                            <div className="obs-table-wrap">
                                <table className="obs-table obs-table--decision">
                                    <thead>
                                        <tr>
                                            <th>Event</th>
                                            <th>Jev Mode</th>
                                            <th>Verdict</th>
                                            <th>Resolver Winner</th>
                                            <th>Jev Hint</th>
                                            <th className="tabular-nums">L0 / Jev Latency</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {decisions.map((d) => (
                                            <tr key={d.id}>
                                                <td className="obs-mono text-slate-300 font-semibold">{d.eventType}</td>
                                                <td>
                                                    <span className="px-1.5 py-0.5 rounded bg-surface-raised border border-surface-border text-[11px] font-mono text-slate-300">
                                                        {d.jevMode ?? '—'}
                                                    </span>
                                                </td>
                                                <td>
                                                    <Badge tone={d.enforcedVerdict === 'ALLOW' ? 'ok' : d.enforcedVerdict === 'BLOCK' ? 'danger' : 'neutral'}>
                                                        {d.enforcedVerdict ?? '—'}
                                                    </Badge>
                                                </td>
                                                <td className="obs-mono text-emerald-400">{d.resolverWinner ?? '—'}</td>
                                                <td className="obs-sub">{d.jevSummary ?? '—'}</td>
                                                <td className="tabular-nums obs-sub text-[11px]">
                                                    {(d as { latencyMsL0?: number }).latencyMsL0 ?? '—'} ms /{' '}
                                                    {(d as { latencyMsJev?: number }).latencyMsJev ?? '—'} ms
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Panel>

                    {/* Conformance Checks */}
                    {checks.length > 0 && (
                        <Panel
                            title="Conformance Gate Checks"
                            lede="Automated governance and safety checks verified against this turn."
                            accent="#4ec97a"
                            badges={<Badge tone="neutral">{checks.length}</Badge>}
                        >
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {checks.map((c) => (
                                    <div
                                        key={c.checkId}
                                        className="p-3 rounded-lg bg-surface-raised border border-surface-border space-y-1"
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-xs text-slate-200">{c.checkId}</span>
                                            <Badge tone={checkStatusTone(c.status)}>{c.status}</Badge>
                                        </div>
                                        {c.detail && <p className="text-[11px] text-slate-400 m-0">{c.detail}</p>}
                                        {c.heuristic && (
                                            <span className="text-[10px] text-slate-500 font-mono italic">
                                                heuristic evaluation
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </Panel>
                    )}

                    {/* Route Trace Events */}
                    {routeEvents.length > 0 && (
                        <Panel title="Route Trace Events" lede="Hook events carrying explicit route decisions" accent="#22d3ee">
                            <ul className="text-xs space-y-1 pl-4 list-disc text-slate-300">
                                {routeEvents.map((e, i) => (
                                    <li key={i}>
                                        <span className="font-mono text-cyan-400">{e.eventType}</span>
                                        {e.tool ? <span className="text-slate-400"> · tool: {e.tool}</span> : ''}
                                        {e.path ? <span className="text-slate-400"> · path: {relPath(detail.callerRootPath, e.path)}</span> : ''}
                                    </li>
                                ))}
                            </ul>
                        </Panel>
                    )}
                </div>
            )}

            {/* TAB 4: Rules & Context */}
            {activeTab === 'rules' && (
                <div className="tab-pane-rules space-y-4 animate-fade-in">
                    <Panel
                        title="Rules Attached at Prompt Time"
                        lede="MDC rules, AGENTS.md playbooks, and skills injected before turn execution."
                        accent="#c084fc"
                        badges={<Badge tone={rulesUsedCount > 0 ? 'ok' : 'neutral'}>{rulesUsedCount} rules</Badge>}
                    >
                        <PromaxRuleBuckets detail={detail} />
                    </Panel>
                </div>
            )}

            {/* TAB 5: Telemetry & Trace */}
            {activeTab === 'telemetry' && (
                <div className="tab-pane-telemetry space-y-4 animate-fade-in">
                    <Panel
                        title="LLM Call Telemetry"
                        lede="Individual LLM invocations, token estimation, and tool emissions"
                        accent="#c084fc"
                        badges={<Badge tone="neutral">{llmCalls.length} calls</Badge>}
                    >
                        {llmCalls.length === 0 ? (
                            <p className="text-xs text-slate-500 m-0">No LLM call details captured.</p>
                        ) : (
                            <div className="space-y-3">
                                {llmCalls.map((c, i) => (
                                    <div
                                        key={c.callIndex ?? i}
                                        className="p-3 rounded-lg bg-surface-raised border border-surface-border text-xs space-y-2"
                                    >
                                        <div className="flex items-center justify-between font-mono">
                                            <span className="text-slate-200 font-semibold">
                                                Call #{c.callIndex ?? i} · <span className="text-purple-400">{c.kind ?? 'single'}</span>
                                            </span>
                                            <span className="text-slate-400 text-[11px]">
                                                {c.textChars ?? '—'} chars · ~{c.estTokens ?? '—'} est. tokens
                                                {c.toolCount ? ` · ${c.toolCount} tool(s)` : ''}
                                            </span>
                                        </div>
                                        {c.toolNames && (
                                            <div className="flex flex-wrap gap-1">
                                                {c.toolNames.split(',').filter(Boolean).map((t) => (
                                                    <span key={t} className="px-1.5 py-0.5 rounded bg-black/30 font-mono text-[10px] text-slate-300">
                                                        {t}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {c.preview && (
                                            <pre className="p-2 bg-black/40 rounded text-slate-300 font-mono text-[11px] whitespace-pre-wrap max-h-36 overflow-y-auto">
                                                {c.preview}
                                            </pre>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>

                    <Panel
                        title="Hook Ingest Events"
                        lede="Raw sequence of preToolUse and postToolUse events recorded by the harness sidecar"
                        accent="#22d3ee"
                        badges={<Badge tone="neutral">{events.length} events</Badge>}
                    >
                        <div className="obs-table-wrap max-h-96 overflow-y-auto scrollbar-thin">
                            <table className="obs-table text-xs">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Event Type</th>
                                        <th>Tool</th>
                                        <th>Target / Command</th>
                                        <th>Timestamp</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {events.map((e, idx) => (
                                        <tr key={idx}>
                                            <td className="font-mono text-slate-500 tabular-nums">{idx + 1}</td>
                                            <td className="font-mono text-cyan-400">{e.eventType ?? '—'}</td>
                                            <td className="font-mono text-slate-200">{e.tool ?? '—'}</td>
                                            <td className="font-mono text-slate-300 max-w-xs truncate" title={e.command || e.path}>
                                                {e.command || (e.path ? relPath(detail.callerRootPath, e.path) : '—')}
                                            </td>
                                            <td className="font-mono text-slate-500 text-[11px]">{e.hookAt ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Panel>
                </div>
            )}
        </section>
    );
}
