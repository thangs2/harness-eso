import { useMemo, useState } from 'react';
import type { RequestDetailResponse } from '@/shared/api/types';
import {
    detailFlowSteps,
    relPath,
} from '@/features/graph/promaxFlowDetail';

type StageFilter = 'all' | 'inspect' | 'edit' | 'verify' | 'shell' | 'memory' | 'attach' | 'other';

interface ExecutionWaterfallProps {
    detail: RequestDetailResponse;
}

const STAGE_THEMES: Record<
    string,
    { label: string; badge: string; border: string; dot: string }
> = {
    attach: {
        label: 'Rule Attach',
        badge: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
        border: 'border-l-purple-500',
        dot: 'bg-purple-400',
    },
    inspect: {
        label: 'Inspect',
        badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
        border: 'border-l-sky-500',
        dot: 'bg-sky-400',
    },
    edit: {
        label: 'Edit',
        badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
        border: 'border-l-amber-500',
        dot: 'bg-amber-400',
    },
    verify: {
        label: 'Verify',
        badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        border: 'border-l-emerald-500',
        dot: 'bg-emerald-400',
    },
    shell: {
        label: 'Shell',
        badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
        border: 'border-l-indigo-500',
        dot: 'bg-indigo-400',
    },
    memory: {
        label: 'Memory',
        badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
        border: 'border-l-rose-500',
        dot: 'bg-rose-400',
    },
    store: {
        label: 'Memory Save',
        badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
        border: 'border-l-rose-500',
        dot: 'bg-rose-400',
    },
    brain: {
        label: 'Brain',
        badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
        border: 'border-l-violet-500',
        dot: 'bg-violet-400',
    },
    other: {
        label: 'Other',
        badge: 'bg-slate-700/50 text-slate-300 border-slate-600',
        border: 'border-l-slate-500',
        dot: 'bg-slate-400',
    },
};

export function ExecutionWaterfall({ detail }: ExecutionWaterfallProps) {
    const [filterStage, setFilterStage] = useState<StageFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});

    const input = useMemo(
        () => ({
            attached: detail.attached,
            rules: detail.rules,
            events: detail.events,
            llmCalls: detail.llmCalls as Array<{ toolNames?: string }> | undefined,
            rootPath: detail.callerRootPath,
        }),
        [detail],
    );

    const steps = useMemo(() => detailFlowSteps(input), [input]);
    const files = (detail.files as Array<{ path: string; reads: number; edits: number; actions?: string }>) ?? [];
    const tools = (detail.tools as Array<{ tool: string; count: number }>) ?? [];
    const llmCalls = (detail.llmCalls as Array<{ callIndex?: number; kind?: string; emitChars?: number; textChars?: number; estTokens?: number; toolCount?: number; toolNames?: string; preview?: string }>) ?? [];
    const maxEmit = Math.max(1, ...llmCalls.map((c) => Number(c.emitChars) || 0));

    // Calculate counts per stage
    const stageCounts = useMemo(() => {
        const counts: Record<string, number> = { all: steps.length };
        for (const s of steps) {
            const st = s.stage === 'store' ? 'memory' : s.stage;
            counts[st] = (counts[st] || 0) + 1;
        }
        return counts;
    }, [steps]);

    // Filter steps
    const filteredSteps = useMemo(() => {
        return steps.filter((s) => {
            const normalizedStage = s.stage === 'store' ? 'memory' : s.stage;
            if (filterStage !== 'all' && normalizedStage !== filterStage) {
                return false;
            }
            if (!searchQuery) return true;
            const q = searchQuery.toLowerCase();
            return (
                s.tool?.toLowerCase().includes(q) ||
                s.path?.toLowerCase().includes(q) ||
                s.command?.toLowerCase().includes(q)
            );
        });
    }, [steps, filterStage, searchQuery]);

    const toggleStep = (index: number) => {
        setExpandedSteps((prev) => ({ ...prev, [index]: !prev[index] }));
    };

    return (
        <div className="execution-waterfall-container space-y-4">
            {/* Filter and Search Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-card border border-surface-border p-3 rounded-xl">
                <div className="flex flex-wrap items-center gap-1.5">
                    {(['all', 'inspect', 'edit', 'verify', 'shell', 'memory', 'attach'] as StageFilter[]).map((st) => {
                        const count = stageCounts[st] || 0;
                        if (count === 0 && st !== 'all') return null;
                        const isSelected = filterStage === st;
                        return (
                            <button
                                key={st}
                                type="button"
                                onClick={() => setFilterStage(st)}
                                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                                    isSelected
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                                        : 'bg-surface-raised text-slate-400 hover:text-slate-200 border border-transparent hover:border-surface-border'
                                }`}
                            >
                                <span className="capitalize">{st}</span>
                                <span className="ml-1.5 text-[10px] tabular-nums opacity-70 px-1 py-0.2 bg-black/20 rounded">
                                    {count}
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="relative min-w-[200px] max-w-xs w-full">
                    <input
                        type="search"
                        placeholder="Filter tools, files, commands…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full text-xs px-3 py-1.5 rounded-lg bg-surface-raised border border-surface-border text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                    />
                </div>
            </div>

            {/* Main Content Layout: 2 Columns */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* Left (8 cols): The Execution Waterfall Timeline */}
                <div className="lg:col-span-8 space-y-2">
                    {filteredSteps.length === 0 ? (
                        <div className="p-8 text-center bg-surface-card border border-surface-border rounded-xl text-slate-400 text-sm">
                            No execution steps match the selected filter.
                        </div>
                    ) : (
                        <div className="space-y-1.5">
                            {filteredSteps.map((step, idx) => {
                                const theme = STAGE_THEMES[step.stage] || STAGE_THEMES.other;
                                const isExpanded = !!expandedSteps[idx];
                                const p = relPath(input.rootPath, step.path);
                                const isMdc = /\.mdc$/i.test(p);
                                const hasCommand = !!step.command && step.command !== step.tool;

                                return (
                                    <div
                                        key={idx}
                                        className={`group bg-surface-card border border-surface-border hover:border-slate-700 rounded-lg p-2.5 transition-all border-l-4 ${theme.border}`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className="text-[11px] font-mono text-slate-500 w-6 shrink-0 text-right">
                                                    #{idx + 1}
                                                </span>
                                                <span
                                                    className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border shrink-0 ${theme.badge}`}
                                                >
                                                    {theme.label}
                                                </span>
                                                {step.tool ? (
                                                    <span className="text-xs font-semibold text-slate-200 font-mono">
                                                        {step.tool}
                                                    </span>
                                                ) : null}
                                                {p ? (
                                                    <span
                                                        className={`text-xs font-mono truncate ${
                                                            isMdc ? 'text-purple-300' : 'text-slate-300'
                                                        }`}
                                                        title={step.path}
                                                    >
                                                        {p}
                                                    </span>
                                                ) : null}
                                            </div>

                                            {hasCommand && (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleStep(idx)}
                                                    className="text-[11px] text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-surface-raised shrink-0 transition-colors"
                                                >
                                                    {isExpanded ? 'Hide' : 'Inspect'}
                                                </button>
                                            )}
                                        </div>

                                        {/* Inline Command / Path Preview if not expanded */}
                                        {hasCommand && !isExpanded && (
                                            <div className="mt-1 pl-8 text-xs font-mono text-slate-400 truncate opacity-85">
                                                $ {step.command}
                                            </div>
                                        )}

                                        {/* Expanded Detailed Accordion */}
                                        {hasCommand && isExpanded && (
                                            <div className="mt-2 pl-8 pt-2 border-t border-surface-border text-xs font-mono">
                                                <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1 font-sans">
                                                    Full Command / Payload
                                                </div>
                                                <pre className="p-2.5 bg-black/40 rounded border border-surface-border text-emerald-400/90 whitespace-pre-wrap break-all overflow-x-auto text-[11px]">
                                                    {step.command}
                                                </pre>
                                                {step.path && (
                                                    <div className="mt-2 text-[11px] text-slate-400">
                                                        <span className="text-slate-500 font-sans">Target: </span>
                                                        <span className="text-slate-300">{step.path}</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Right (4 cols): Context Diagnostics Panels */}
                <div className="lg:col-span-4 space-y-4">
                    {/* Files Touched Panel */}
                    <div className="bg-surface-card border border-surface-border rounded-xl p-3 shadow-sm">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                                Files Touched ({files.length})
                            </h3>
                            <span className="text-[10px] text-slate-500">reads / edits</span>
                        </div>
                        {files.length === 0 ? (
                            <p className="text-xs text-slate-500 m-0">No files modified or read.</p>
                        ) : (
                            <div className="space-y-1.5 max-h-[280px] overflow-y-auto scrollbar-thin pr-1">
                                {files.map((f) => (
                                    <div
                                        key={f.path}
                                        className="flex items-center justify-between gap-2 p-1.5 rounded bg-surface-raised border border-surface-border text-xs"
                                    >
                                        <span
                                            className="font-mono text-slate-300 truncate text-[11px]"
                                            title={f.path}
                                        >
                                            {relPath(detail.callerRootPath, f.path)}
                                        </span>
                                        <span className="shrink-0 px-1.5 py-0.5 rounded bg-black/30 font-mono text-[10px] text-slate-400">
                                            {f.actions ?? `${f.reads}r/${f.edits}e`}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Tools Distribution Panel */}
                    <div className="bg-surface-card border border-surface-border rounded-xl p-3 shadow-sm">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                            Tool Call Breakdown ({tools.length})
                        </h3>
                        {tools.length === 0 ? (
                            <p className="text-xs text-slate-500 m-0">No tools recorded.</p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {tools.map((x) => (
                                    <span
                                        key={x.tool}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-raised border border-surface-border text-xs font-mono text-slate-300"
                                    >
                                        <span>{x.tool}</span>
                                        <span className="text-[10px] text-emerald-400 font-semibold bg-emerald-500/10 px-1 rounded">
                                            ×{x.count}
                                        </span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* LLM Timeline Mini-Chart */}
                    {llmCalls.length > 0 && (
                        <div className="bg-surface-card border border-surface-border rounded-xl p-3 shadow-sm">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                                LLM Call Emissions ({llmCalls.length})
                            </h3>
                            <div className="space-y-2 max-h-[220px] overflow-y-auto scrollbar-thin">
                                {llmCalls.map((c, i) => {
                                    const emit = Number(c.emitChars) || 0;
                                    const barW = Math.round((emit / maxEmit) * 100);
                                    return (
                                        <div key={c.callIndex ?? i} className="text-xs space-y-0.5">
                                            <div className="flex items-center justify-between text-[11px] text-slate-400">
                                                <span>#{c.callIndex ?? i} · {c.kind ?? 'call'}</span>
                                                <span className="font-mono text-slate-300">
                                                    ~{c.estTokens ?? '—'} tok ({c.textChars ?? '—'} ch)
                                                </span>
                                            </div>
                                            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                                <div
                                                    className="bg-purple-500 h-1.5 rounded-full"
                                                    style={{ width: `${Math.max(4, barW)}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
