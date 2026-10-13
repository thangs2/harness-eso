import type { DecisionFlowVm, RequestDetailResponse } from '@/shared/api/types';
import { PromaxDesignGraphPanel } from '@/features/graph/PromaxG6Panels';
import { DecisionFlowView } from '@/features/requests/DecisionFlowView';
import { flowRulesByBucket, relPath } from '@/features/graph/promaxFlowDetail';
import { PromaxFlowPane, PromaxRuleBuckets } from '@/features/requests/PromaxFlowPane';
import { Badge } from '@/ui/Badge';
import type { FlowGraphVm } from '@/shared/api/types';
import { Panel } from '@/ui/Panel';
import { checkStatusTone } from '@/ui/statusTone';

type LlmCallRow = {
    callIndex?: number;
    kind?: string;
    toolCount?: number;
    toolNames?: string;
    emitChars?: number;
    textChars?: number;
    estTokens?: number;
    preview?: string;
};

export function RequestDrillBlocks({ detail }: { detail: RequestDetailResponse }) {
    const evidence = detail.evidence as Record<string, unknown> | undefined;
    const checks = (detail.checks as Array<{ checkId: string; status: string; detail?: string; heuristic?: boolean }>) ?? [];
    const tools = (detail.tools as Array<{ tool: string; count: number }>) ?? [];
    const files = (detail.files as Array<{ path: string; reads: number; edits: number; actions?: string }>) ?? [];
    const llmCalls = (detail.llmCalls as LlmCallRow[]) ?? [];
    const flow = detail.decisionFlow as DecisionFlowVm | null | undefined;
    const events = (detail.events as Array<{ eventType?: string; tool?: string; path?: string }>) ?? [];
    const routeEvents = events.filter((e) => /route/i.test(String(e.eventType || '')));
    const rulesUsedCount = flowRulesByBucket({
        attached: detail.attached,
        rules: detail.rules,
        rootPath: detail.tenantRootPath,
    }).reduce((n, g) => n + g.items.length, 0);

    const maxEmit = Math.max(1, ...llmCalls.map((c) => Number(c.emitChars) || 0));

    return (
        <div className="drill-blocks">
            {flow ? <DecisionFlowView flow={flow} /> : null}

            {/* "Evidence (ESO) — this request only" used to live here. Every field it showed
                (level, score, gaps) is already in the Evidence & consent card above, and the
                two could disagree once one was updated. The card owns that data now; the ESO
                topology panel below keeps the graph half. */}

            {evidence &&
            (evidence.designGraph as FlowGraphVm | undefined)?.nodes?.length ? (
                <Panel
                    title="ESO topology"
                    lede="§V11 preflight vs ingest · §V12 cognition tiers · §V6 data plane. Green = this request."
                    accent="#38bdf8"
                    badges={<Badge tone="neutral">evidence</Badge>}
                >
                    <PromaxDesignGraphPanel
                        graph={evidence.designGraph as FlowGraphVm}
                        legend={(evidence.designGraph as FlowGraphVm).legend}
                    />
                </Panel>
            ) : null}

            <PromaxFlowPane detail={detail} />

            <div className="promax-drill-grid">
                <Panel
                    title="call timeline"
                    lede="One row per LLM call. Bar width is emitted characters."
                    accent="#c084fc"
                    className="promax-drill-main"
                    footer={
                        llmCalls.length > 0 ? (
                            <>
                                <span className="obs-card-flag">
                                    calls <b className="tabular-nums">{llmCalls.length}</b>
                                </span>
                                <span className="obs-card-flag">
                                    single{' '}
                                    <b className="tabular-nums">
                                        {llmCalls.filter((c) => c.kind === 'single').length}
                                    </b>
                                </span>
                                <span className="obs-card-flag">
                                    batched{' '}
                                    <b className="tabular-nums">
                                        {llmCalls.filter((c) => c.kind === 'batched').length}
                                    </b>
                                </span>
                                <span className="obs-card-flag">
                                    answer{' '}
                                    <b className="tabular-nums">
                                        {llmCalls.filter((c) => c.kind === 'answer').length}
                                    </b>
                                </span>
                            </>
                        ) : null
                    }
                >
                    {llmCalls.length === 0 ? (
                        <p className="obs-sub m-0">no calls recorded</p>
                    ) : (
                        <div className="promax-call-timeline">
                                {llmCalls.map((c, i) => {
                                    const emit = Number(c.emitChars) || 0;
                                    const barW = Math.round((emit / maxEmit) * 130);
                                    return (
                                        <div
                                            key={c.callIndex ?? i}
                                            className={`tl${c.kind === 'single' ? ' tl-single' : ''}`}
                                        >
                                            <div className="tl-i">#{c.callIndex ?? i}</div>
                                            <div>
                                                <span
                                                    className="bar-tokens"
                                                    style={{ width: `${barW}px` }}
                                                />
                                                <span className="obs-sub">
                                                    {' '}
                                                    {c.textChars ?? '—'} chars · ~{c.estTokens ?? '—'} tok
                                                    (est.)
                                                    {c.toolCount ? ` · ${c.toolCount} tool` : ''}
                                                </span>
                                                {c.kind ? (
                                                    <span className={`ktag k-${c.kind}`}>{c.kind}</span>
                                                ) : null}
                                                {c.toolNames ? (
                                                    <div className="chips mt-1">
                                                        {c.toolNames
                                                            .split(',')
                                                            .filter(Boolean)
                                                            .map((t) => (
                                                                <span key={t} className="chip">{t}</span>
                                                            ))}
                                                    </div>
                                                ) : null}
                                                {c.preview ? (
                                                    <div className="obs-sub mt-1">
                                                        {c.preview.slice(0, 150)}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    )}
                </Panel>

                <div className="promax-drill-side">
                    {checks.length > 0 && (
                        <Panel
                            title="conformance"
                            lede="Checks the harness ran on this turn."
                            accent="#4ec97a"
                            badges={<Badge tone="neutral">{checks.length}</Badge>}
                        >
                            {checks.map((c) => (
                                <div key={c.checkId} className="conformance-row">
                                    <div className="conformance-head">
                                        <Badge tone={checkStatusTone(c.status)}>{c.status}</Badge>
                                        <b>{c.checkId}</b>
                                        {c.heuristic ? <span className="obs-sub">heuristic</span> : null}
                                    </div>
                                    {c.detail ? <div className="obs-sub">{c.detail}</div> : null}
                                </div>
                            ))}
                        </Panel>
                    )}

                    <Panel
                        title="rules attached at prompt time"
                        lede="What the IDE attached before the turn ran."
                        accent="#c084fc"
                        badges={<Badge tone={rulesUsedCount > 0 ? 'ok' : 'neutral'}>{rulesUsedCount}</Badge>}
                    >
                        <PromaxRuleBuckets detail={detail} />
                    </Panel>

                    <Panel
                        title="tools"
                        lede="Every tool the turn called, with call count."
                        accent="#e0b341"
                        badges={<Badge tone="neutral">{tools.length}</Badge>}
                    >
                        <div className="chips">
                            {tools.length
                                ? tools.map((x) => (
                                      <span key={x.tool} className="chip">
                                          {x.tool} ×{x.count}
                                      </span>
                                  ))
                                : <span className="obs-sub">none</span>}
                        </div>
                    </Panel>

                    <Panel
                        title="files"
                        lede="Reads and edits, relative to the consumer repo."
                        accent="#8b97ab"
                        badges={<Badge tone="neutral">{files.length}</Badge>}
                    >
                        {files.length
                            ? files.map((f) => (
                                  <div key={f.path} className="files-row">
                                      <span className="files-action">
                                          {f.actions ?? `${f.reads}r/${f.edits}e`}
                                      </span>
                                      <span className="files-path obs-mono">
                                          {relPath(detail.tenantRootPath, f.path)}
                                      </span>
                                  </div>
                              ))
                            : <span className="obs-sub">none</span>}
                    </Panel>
                </div>
            </div>

            {routeEvents.length > 0 && (
                <Panel
                    title="Route trace"
                    lede="Hook events that carried a route decision for this turn."
                    accent="#22d3ee"
                >
                    <ul className="text-sm m-0 pl-5 space-y-1">
                        {routeEvents.slice(0, 24).map((e, i) => (
                            <li key={i}>
                                {e.eventType}
                                {e.tool ? ` · ${e.tool}` : ''}
                                {e.path ? ` · ${e.path}` : ''}
                            </li>
                        ))}
                    </ul>
                </Panel>
            )}
        </div>
    );
}
