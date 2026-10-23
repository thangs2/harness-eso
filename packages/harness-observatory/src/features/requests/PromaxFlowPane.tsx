import { useMemo } from 'react';
import type { FlowGraphVm, RequestDetailResponse } from '@/shared/api/types';
import { PromaxFlowGraphPanel } from '@/features/graph/PromaxG6Panels';
import {
    detailFlowSteps,
    flowMetaLine,
    flowRulesByBucket,
    relPath,
    STAGE_LABEL,
    type FlowDetailInput,
} from '@/features/graph/promaxFlowDetail';
import { RULE_BUCKET_LABEL } from '@/features/graph/promaxFlowStyles';

function flowDetailInput(detail: RequestDetailResponse): FlowDetailInput {
    return {
        attached: detail.attached,
        rules: detail.rules,
        events: detail.events,
        llmCalls: detail.llmCalls as Array<{ toolNames?: string }> | undefined,
        rootPath: detail.callerRootPath,
    };
}

function PromaxFlowSteps({ detail }: { detail: RequestDetailResponse }) {
    const input = flowDetailInput(detail);
    const steps = useMemo(() => detailFlowSteps(input), [detail]);

    if (!steps.length) {
        return <div className="fempty obs-sub">no tool calls recorded for this request</div>;
    }

    return (
        <div className="promax-flow-timeline">
            {steps.map((s, i) => {
                const p = relPath(input.rootPath, s.path);
                const isMdc = /\.mdc$/i.test(p);
                const cmd =
                    s.command && s.command.length > 110
                        ? `${s.command.slice(0, 110)}…`
                        : s.command;
                const bucketLabel =
                    s.stage === 'attach' && s.ruleBucket
                        ? RULE_BUCKET_LABEL[s.ruleBucket] || s.ruleBucket
                        : null;
                return (
                    <div key={i} className={`fstep st-${s.stage}`}>
                        <span className="fi">{i + 1}</span>
                        <span className="ftag">
                            {bucketLabel || STAGE_LABEL[s.stage] || s.stage}
                        </span>
                        <span className="fb">
                            {s.tool ? <b>{s.tool}</b> : null}
                            {p ? (
                                <>
                                    {s.tool ? ' ' : null}
                                    <span className={isMdc ? 'fmdc' : 'fpath'}>{p}</span>
                                </>
                            ) : null}
                            {cmd && cmd !== s.tool ? (
                                <>
                                    {' '}
                                    <span className="fcmd">{cmd}</span>
                                </>
                            ) : null}
                            {!s.tool && !p && !(cmd && cmd !== s.tool) ? (
                                <span className="obs-sub">·</span>
                            ) : null}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function PromaxRuleBucketsInner({ detail }: { detail: RequestDetailResponse }) {
    const ruleGroups = useMemo(
        () => flowRulesByBucket(flowDetailInput(detail)),
        [detail],
    );

    if (!ruleGroups.length) {
        return null;
    }

    return (
        <div className="rule-buckets">
            {ruleGroups.map((g) => (
                <div key={g.bucket} className="rule-bucket">
                    <div className="rule-bucket-title">
                        {g.label}{' '}
                        <span className="text-slate-500">({g.items.length})</span>
                    </div>
                    <div className="chips">
                        {g.items.map((e) => {
                            const name = e.path.split(/[\\/]/).pop() || e.path;
                            const tip = [g.label, e.attachType, e.path].filter(Boolean).join(' · ');
                            return (
                                <span
                                    key={e.path}
                                    className={`chip chip-rule-${e.bucket}`}
                                    title={tip}
                                >
                                    {name}
                                </span>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function PromaxFlowPane({ detail }: { detail: RequestDetailResponse }) {
    const input = flowDetailInput(detail);
    const steps = useMemo(() => detailFlowSteps(input), [detail]);
    const meta = flowMetaLine(input, steps);
    const flowGraph = detail.flowGraph as FlowGraphVm | null | undefined;
    const evidenceNote = detail.evidenceNote;
    const showGraphHost = Boolean(flowGraph?.nodes?.length);

    return (
        <div className="obs-panel promax-flow-card">
            <div className="promax-flow-card-head">
                <span className="obs-sub">
                    flow — rules it ran under, then what it called, in order
                </span>
                {meta ? <span className="obs-sub promax-flow-meta">{meta}</span> : null}
            </div>
            {evidenceNote ? (
                <p className="obs-sub m-0 mb-2 text-amber-200/90">{evidenceNote}</p>
            ) : null}
            {showGraphHost ? (
                <PromaxFlowGraphPanel graph={flowGraph} />
            ) : (
                <div className="promax-d-graph g6-fallback-host">
                    <div className="g6-fallback obs-sub">
                        no tool calls recorded for this request
                    </div>
                </div>
            )}
            <div className="promax-flow-rule-buckets">
                <PromaxRuleBucketsInner detail={detail} />
            </div>
            <details className="promax-steps-wrap">
                <summary className="obs-sub">raw steps, in call order</summary>
                <PromaxFlowSteps detail={detail} />
            </details>
        </div>
    );
}

export function PromaxRuleBuckets({ detail }: { detail: RequestDetailResponse }) {
    const ruleGroups = flowRulesByBucket(flowDetailInput(detail));
    if (!ruleGroups.length) {
        return <span className="obs-sub">none recorded</span>;
    }
    return <PromaxRuleBucketsInner detail={detail} />;
}
