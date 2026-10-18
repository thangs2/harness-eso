import type { RequestDetailResponse } from '@/shared/api/types';
import { type ReactNode, useMemo } from 'react';

export type PipelineStageId =
    | 'prompt'
    | 'law'
    | 'routing'
    | 'recon'
    | 'eso'
    | 'brain'
    | 'exec'
    | 'memory';

export type PipelineStepperProps = {
    detail: RequestDetailResponse;
    activeTab?: string;
    onSelectStage?: (stageId: PipelineStageId, recommendedTab: string) => void;
};

interface StageMeta {
    id: PipelineStageId;
    stepNumber: number;
    title: string;
    sub: string;
    status: 'ok' | 'warn' | 'info' | 'muted';
    tab: string;
    icon: (cls?: string) => ReactNode;
}

export function PipelineStepper({ detail, onSelectStage }: PipelineStepperProps) {
    const req = detail.request as Record<string, unknown> | undefined;
    const boundary = req?.boundaryIndex ?? req?.boundary_index;
    const attached = detail.attached ?? [];
    const events = (detail.events as Array<{ eventType?: string; tool?: string; command?: string }>) ?? [];
    const flow = detail.decisionFlow;
    const eso = detail.eso;
    const sufficiency = eso?.sufficiency ?? (detail.evidence?.level as string | undefined);
    const score = typeof eso?.score === 'number' ? Math.round(eso.score * 100) : null;
    const gapsCount = eso?.gaps?.length ?? 0;
    const metrics = detail.requestMetrics;

    const stages: StageMeta[] = useMemo(() => {
        // 1. Law Gate detection
        const hasLaw = attached.some(
            (a) =>
                /AGENTS\.md$/i.test(String(a.filePath || '')) ||
                /core\.law-gate\.mdc$/i.test(String(a.filePath || '')),
        );

        // 2. Routing detection
        const winner = flow?.decisions?.[0]?.resolverWinner || (flow?.mcpStats ? 'smart-tier' : 'L0 direct');
        const jevMode = flow?.decisions?.[0]?.jevMode;

        // 3. Recon detection
        const reconEvents = events.filter((e) => {
            const t = String(e.tool || '').toLowerCase();
            const c = String(e.command || '').toLowerCase();
            return (
                t.includes('view_file') ||
                t.includes('grep_search') ||
                t.includes('list_dir') ||
                t.includes('read_url_content') ||
                t.includes('docgraph') ||
                t.includes('codegraph') ||
                t.includes('memory_recall') ||
                c.includes('docgraph') ||
                c.includes('codegraph')
            );
        });

        // 4. ESO Gate status
        let esoStatus: 'ok' | 'warn' | 'info' | 'muted' = 'ok';
        if (sufficiency === 'insufficient' || gapsCount > 0) {
            esoStatus = 'warn';
        } else if (!sufficiency) {
            esoStatus = 'info';
        }

        // 5. Brain status
        const brainCalls = (detail.llmCalls as Array<{ kind?: string }>) ?? [];
        const model = metrics?.modelId || (flow?.mcpStats?.pro ? 'DeepSeek Pro' : 'Direct / Local');

        // 6. Execution status
        const execEvents = events.filter((e) => e.eventType === 'postToolUse' || e.tool);

        // 7. Memory status
        const hasMemory = events.some((e) => {
            const t = String(e.tool || '').toLowerCase();
            return t.includes('memory_save') || t.includes('memory_lesson_save') || t.includes('memory');
        });

        return [
            {
                id: 'prompt',
                stepNumber: 1,
                title: 'Prompt Ingest',
                sub: boundary != null ? `Turn #${boundary}` : 'Received',
                status: 'ok',
                tab: 'waterfall',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                ),
            },
            {
                id: 'law',
                stepNumber: 2,
                title: 'Law Gate',
                sub: hasLaw ? 'Enforced' : 'Attached',
                status: hasLaw ? 'ok' : 'info',
                tab: 'rules',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                ),
            },
            {
                id: 'routing',
                stepNumber: 3,
                title: 'L0/Jev Route',
                sub: jevMode ? `${winner} (${jevMode})` : winner,
                status: 'ok',
                tab: 'decisions',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                ),
            },
            {
                id: 'recon',
                stepNumber: 4,
                title: 'Recon Context',
                sub: `${reconEvents.length} inspected`,
                status: reconEvents.length > 0 ? 'ok' : 'muted',
                tab: 'waterfall',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                ),
            },
            {
                id: 'eso',
                stepNumber: 5,
                title: 'ESO Gate',
                sub: sufficiency ? `${sufficiency}${score != null ? ` (${score}%)` : ''}` : 'Direct',
                status: esoStatus,
                tab: 'decisions',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 3v18M3 9l9-6 9 6M3 9a6 6 0 0 0 12 0M9 9a6 6 0 0 0 12 0" />
                    </svg>
                ),
            },
            {
                id: 'brain',
                stepNumber: 6,
                title: 'Brain Tier',
                sub: brainCalls.length > 0 ? `${model} (${brainCalls.length} calls)` : model,
                status: 'ok',
                tab: 'telemetry',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" />
                        <line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" />
                        <line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" />
                        <line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" />
                        <line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                ),
            },
            {
                id: 'exec',
                stepNumber: 7,
                title: 'Execution',
                sub: `${execEvents.length} tools called`,
                status: execEvents.length > 0 ? 'ok' : 'muted',
                tab: 'waterfall',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                ),
            },
            {
                id: 'memory',
                stepNumber: 8,
                title: 'Distill & Memory',
                sub: hasMemory ? 'Distilled' : 'Pass-through',
                status: hasMemory ? 'ok' : 'muted',
                tab: 'waterfall',
                icon: (cls) => (
                    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <polyline points="17 21 17 13 7 13 7 21" />
                        <polyline points="7 3 7 8 15 8" />
                    </svg>
                ),
            },
        ];
    }, [attached, events, flow, sufficiency, score, gapsCount, metrics, boundary, detail.llmCalls]);

    return (
        <nav
            aria-label="Pipeline execution stages"
            className="obs-stepper-container bg-surface-card border border-surface-border rounded-xl p-3 mb-4 shadow-sm"
        >
            <div className="flex items-center justify-between gap-1 overflow-x-auto pb-1 scrollbar-thin">
                {stages.map((st, idx) => {
                    const statusBg =
                        st.status === 'ok'
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
                            : st.status === 'warn'
                            ? 'bg-amber-500/15 text-amber-400 border-amber-500/40 animate-pulse'
                            : st.status === 'info'
                            ? 'bg-sky-500/15 text-sky-400 border-sky-500/40'
                            : 'bg-slate-800 text-slate-400 border-slate-700';

                    return (
                        <div key={st.id} className="flex items-center shrink-0">
                            <button
                                type="button"
                                onClick={() => onSelectStage?.(st.id, st.tab)}
                                title={`Step ${st.stepNumber}: ${st.title} — Click to inspect ${st.tab}`}
                                className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-transparent hover:border-surface-border hover:bg-surface-raised transition-all text-left"
                            >
                                <div
                                    className={`w-7 h-7 rounded-full flex items-center justify-center border text-xs font-semibold shrink-0 transition-transform group-hover:scale-105 ${statusBg}`}
                                >
                                    {st.icon('w-3.5 h-3.5')}
                                </div>
                                <div className="leading-tight">
                                    <div className="text-[11px] font-medium text-slate-200 group-hover:text-emerald-300 flex items-center gap-1">
                                        <span className="text-slate-500 text-[10px] tabular-nums">#{st.stepNumber}</span>
                                        <span>{st.title}</span>
                                    </div>
                                    <div className="text-[10px] text-slate-400 max-w-[110px] truncate" title={st.sub}>
                                        {st.sub}
                                    </div>
                                </div>
                            </button>
                            {idx < stages.length - 1 && (
                                <div className="w-3 h-[1px] bg-slate-800 mx-0.5 shrink-0" aria-hidden="true" />
                            )}
                        </div>
                    );
                })}
            </div>
        </nav>
    );
}
