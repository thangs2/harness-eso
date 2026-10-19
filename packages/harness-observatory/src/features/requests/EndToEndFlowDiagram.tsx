import { useMemo, useState } from 'react';
import type { RequestDetailResponse } from '@/shared/api/types';
import { Badge } from '@/ui/Badge';

export interface EndToEndFlowDiagramProps {
    detail: RequestDetailResponse;
    className?: string;
}

export function EndToEndFlowDiagram({ detail, className = '' }: EndToEndFlowDiagramProps) {
    const [viewMode, setViewMode] = useState<'trace' | 'spec'>('trace');
    const [isExpanded, setIsExpanded] = useState(true);

    const req = detail.request as Record<string, unknown> | undefined;
    const attached = detail.attached ?? [];
    const events = (detail.events as Array<{ eventType?: string; tool?: string; path?: string; command?: string }>) ?? [];
    const flow = detail.decisionFlow;
    const eso = detail.eso;
    const llmCalls = (detail.llmCalls as Array<{ kind?: string; estTokens?: number }>) ?? [];

    // Telemetry analysis for active path determination
    const trace = useMemo(() => {
        // Step 1: Law Gate
        const hasLaw = attached.some(
            (a) =>
                /AGENTS\.md$/i.test(String(a.filePath || '')) ||
                /core\.law-gate\.mdc$/i.test(String(a.filePath || '')),
        );

        // Step 2: Decision Facade (L0 vs Jev)
        const primaryDecision = flow?.decisions?.[0];
        const winner = primaryDecision?.resolverWinner || (flow?.mcpStats ? 'smart-tier' : 'l0_resolver');
        const jevMode = primaryDecision?.jevMode ?? 'off';
        const isL0Winner = /l0/i.test(winner) || winner === 'l1_shell_allow' || winner === 'l1_shell_deny' || winner === 'l0_resolver';
        const isJevWinner = /jev/i.test(winner);
        const isHil = /confirm|ask|hil/i.test(winner);

        // Step 3: Recon Adapters
        let docgraphCalls = 0;
        let codegraphCalls = 0;
        let memoryCalls = 0;

        for (const e of events) {
            const tool = String(e.tool || '').toLowerCase();
            const cmd = String(e.command || '').toLowerCase();
            if (tool.includes('docgraph') || cmd.includes('docgraph')) docgraphCalls++;
            if (tool.includes('codegraph') || cmd.includes('codegraph')) codegraphCalls++;
            if (tool.includes('memory') || cmd.includes('memory')) memoryCalls++;
        }

        // Step 4: ESO Gate
        const sufficiency = eso?.sufficiency ?? (detail.evidence?.level as string | undefined) ?? 'sufficient';
        const score = typeof eso?.score === 'number' ? Math.round(eso.score * 100) : 100;
        const gaps = eso?.gaps ?? [];
        const isSufficient = sufficiency === 'sufficient' && gaps.length === 0;
        const isPartial = sufficiency === 'partial';
        const isInsufficient = sufficiency === 'insufficient' || gaps.length > 0;

        // Step 5: Brain Tier Routing
        const hasPro = (flow?.mcpStats?.pro ?? 0) > 0 || llmCalls.some((c) => /pro/i.test(c.kind || ''));
        const hasFlash = (flow?.mcpStats?.flashBrain ?? 0) > 0 || (flow?.mcpStats?.flashExecutor ?? 0) > 0 || llmCalls.some((c) => /flash/i.test(c.kind || ''));
        const activeBrain: 'zero' | 'flash' | 'pro' = hasPro ? 'pro' : hasFlash ? 'flash' : 'zero';

        // Step 6: Execution
        const toolCalls = events.filter((e) => e.eventType === 'postToolUse' || e.tool);
        const editCalls = events.filter((e) => {
            const t = String(e.tool || '').toLowerCase();
            return t.includes('replace') || t.includes('write') || t.includes('edit');
        });

        // Step 7: Memory Save
        const memorySaved = events.some((e) => {
            const t = String(e.tool || '').toLowerCase();
            return t.includes('memory_save') || t.includes('memory_lesson_save');
        });

        return {
            hasLaw,
            winner,
            jevMode,
            isL0Winner,
            isJevWinner,
            isHil,
            docgraphCalls,
            codegraphCalls,
            memoryCalls,
            sufficiency,
            score,
            gaps,
            isSufficient,
            isPartial,
            isInsufficient,
            activeBrain,
            toolCallsCount: toolCalls.length,
            editCallsCount: editCalls.length,
            memorySaved,
        };
    }, [attached, events, flow, eso, detail.evidence, llmCalls]);

    return (
        <section
            className={`end-to-end-flow-card border border-surface-border bg-surface-card rounded-2xl overflow-hidden shadow-xl transition-all ${className}`}
        >
            {/* Header Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 bg-surface-raised/70 border-b border-surface-border">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 font-bold text-sm shadow-sm">
                        ⚡
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-white tracking-wide m-0">
                                End-to-End Pipeline Data Flow & Decision Orchestration
                            </h3>
                            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                                07.dataflow.md · V2.0
                            </span>
                        </div>
                        <p className="text-xs text-slate-400 m-0 mt-0.5">
                            Turn lifecycle: Preflight (HOT/WARM/COLD) → Decision Facade &amp; Lanes → Recon → ESO Gate + HMAC Receipt → Brain → Execution → Distillation
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* View mode toggle */}
                    <div className="flex items-center bg-surface-card border border-surface-border rounded-lg p-0.5 text-xs">
                        <button
                            type="button"
                            onClick={() => setViewMode('trace')}
                            className={`px-3 py-1 font-medium rounded-md transition-all ${
                                viewMode === 'trace'
                                    ? 'bg-sky-500 text-white shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Turn Trace Active
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode('spec')}
                            className={`px-3 py-1 font-medium rounded-md transition-all ${
                                viewMode === 'spec'
                                    ? 'bg-purple-600 text-white shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Full Normative Spec
                        </button>
                    </div>

                    <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="px-2.5 py-1 text-xs font-mono text-slate-400 hover:text-white bg-surface-card hover:bg-surface-raised border border-surface-border rounded-lg transition-colors"
                        title={isExpanded ? 'Collapse diagram' : 'Expand diagram'}
                    >
                        {isExpanded ? '▲ Hide' : '▼ Show Flow'}
                    </button>
                </div>
            </div>

            {isExpanded && (
                <div className="p-5 overflow-x-auto bg-[#0a0e17] scrollbar-thin scrollbar-thumb-surface-border">
                    <div className="min-w-[960px] flex flex-col gap-6 relative">
                        {/* ========================================================================= */}
                        {/* STEP 1: INITIALIZATION & LAW GATE */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-emerald-500/70 text-emerald-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(16,185,129,0.3)]">
                                    1
                                </div>
                                <div className="w-0.5 flex-1 bg-gradient-to-b from-emerald-500/70 to-purple-500/50 my-1" />
                            </div>

                            <div className="flex-1 bg-surface-card/90 border border-emerald-500/40 rounded-xl p-4 shadow-sm hover:border-emerald-400/60 transition-all">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                                            Step 1 · Cognitive Preflight & Fingerprint Gates
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                            (Law Gate · Context Contract · HOT / WARM / COLD)
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {trace.hasLaw ? (
                                            <Badge tone="ok">AGENTS.md Verified</Badge>
                                        ) : (
                                            <Badge tone="neutral">Standard Context</Badge>
                                        )}
                                        {req?.boundaryIndex != null && (
                                            <span className="text-[11px] font-mono text-slate-400 bg-surface-raised px-2 py-0.5 rounded">
                                                Turn #{String(req.boundaryIndex)}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-3 text-xs">
                                    <div className="p-2.5 rounded-lg bg-surface-raised/60 border border-surface-border/50">
                                        <div className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                            Context Contract &amp; Law Gate
                                        </div>
                                        <p className="text-[11px] text-slate-400 m-0">
                                            Load <code>00.context-contract.json</code> → resolve <code>domain_slug</code> and pinned <code>INV-*</code>; enforce AGENTS.md law.
                                        </p>
                                    </div>

                                    <div className="p-2.5 rounded-lg bg-surface-raised/60 border border-surface-border/50">
                                        <div className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                                            Fingerprint Gates G1 / G2
                                        </div>
                                        <p className="text-[11px] text-slate-400 m-0">
                                            G1: stem &lt; 6 chars never goes HOT. G2: missing or dirty git fingerprint fails closed to COLD.
                                        </p>
                                    </div>

                                    <div className="p-2.5 rounded-lg bg-surface-raised/60 border border-surface-border/50">
                                        <div className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                            HOT / WARM / COLD
                                        </div>
                                        <p className="text-[11px] text-slate-400 m-0">
                                            HOT: 0ms, 0 tokens injected. WARM: ≤30-token JIT-pin of <code>INV-*</code>. COLD: full recon + gap directive.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ========================================================================= */}
                        {/* STEP 2: CLASSIFICATION & DECISION FACADE (L0 vs Jev) */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-purple-500/70 text-purple-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(168,85,247,0.3)]">
                                    2
                                </div>
                                <div className="w-0.5 flex-1 bg-gradient-to-b from-purple-500/50 to-sky-500/50 my-1" />
                            </div>

                            <div className="flex-1 bg-surface-card/90 border border-purple-500/40 rounded-xl p-4 shadow-sm hover:border-purple-400/60 transition-all">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
                                            Step 2 · Decision Facade & Lane Routing
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                            (L0 vs Jev · Lane A enriched Jira / B fallback / C intake)
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] text-slate-400">Winner:</span>
                                        <Badge tone={trace.isL0Winner ? 'ok' : trace.isJevWinner ? 'info' : 'warn'}>
                                            {trace.winner}
                                        </Badge>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    {/* L0 Branch */}
                                    <div
                                        className={`rounded-xl p-3.5 border transition-all ${
                                            viewMode === 'trace' && trace.isL0Winner
                                                ? 'bg-purple-950/20 border-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.15)] ring-1 ring-purple-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-75'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-purple-300">
                                                    Level L0: Deterministic Rules
                                                </span>
                                                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">
                                                    0ms · Zero Cost
                                                </span>
                                            </div>
                                            {viewMode === 'trace' && trace.isL0Winner && (
                                                <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                                                    ● Executed
                                                </span>
                                            )}
                                        </div>
                                        <ul className="text-[11px] text-slate-300 space-y-1.5 m-0 pl-4 list-disc">
                                            <li>
                                                <strong className="text-slate-200">Shell Commands:</strong> Deny dangerous (`rm -rf`, `dropdb`), allow safe read (`git status`, `ls`).
                                            </li>
                                            <li>
                                                <strong className="text-slate-200">Route Buckets:</strong> Resolves if 1 bucket clearly matches (`frontend`, `backend`, `docs`).
                                            </li>
                                            <li>
                                                <span className="text-amber-300">Ambiguity Check:</span> If tie score (`l0.tie`) → Escalate to Jev L1/L2.
                                            </li>
                                        </ul>
                                    </div>

                                    {/* Jev L1/L2 Branch */}
                                    <div
                                        className={`rounded-xl p-3.5 border transition-all ${
                                            viewMode === 'trace' && trace.isJevWinner
                                                ? 'bg-sky-950/20 border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.15)] ring-1 ring-sky-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-75'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-sky-300">
                                                    Level L1/L2: Jev System One
                                                </span>
                                                <span className="text-[10px] font-mono text-sky-400 bg-sky-500/10 px-1.5 py-0.2 rounded border border-sky-500/20">
                                                    api.typesafe.ai
                                                </span>
                                            </div>
                                            {viewMode === 'trace' && trace.isJevWinner && (
                                                <span className="text-[10px] font-bold text-sky-400 flex items-center gap-1">
                                                    ● Executed
                                                </span>
                                            )}
                                        </div>
                                        <ul className="text-[11px] text-slate-300 space-y-1.5 m-0 pl-4 list-disc">
                                            <li>
                                                <strong className="text-slate-200">High Confidence (≥ 0.9):</strong> Jev automatically breaks tie (`route_jev`).
                                            </li>
                                            <li>
                                                <strong className="text-slate-200">Low Confidence (&lt; 0.9):</strong> Halts and prompts human operator (`HIL Required`).
                                            </li>
                                            <li>
                                                <span className="text-slate-400">Current Mode:</span>{' '}
                                                <code className="text-sky-300 font-mono text-[10px]">{trace.jevMode}</code>
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ========================================================================= */}
                        {/* STEP 3: RECONNAISSANCE VIA ADAPTERS */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-sky-500/70 text-sky-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(56,189,248,0.3)]">
                                    3
                                </div>
                                <div className="w-0.5 flex-1 bg-gradient-to-b from-sky-500/50 to-amber-500/50 my-1" />
                            </div>

                            <div className="flex-1 bg-surface-card/90 border border-sky-500/40 rounded-xl p-4 shadow-sm hover:border-sky-400/60 transition-all">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
                                            Step 3 · Reconnaissance via Adapters
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                            (COLD turns only — Delta-scoped, zero file dump)
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className="text-slate-400">Telemetry:</span>
                                        <span className="px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 font-mono text-[11px] border border-sky-500/20">
                                            {trace.docgraphCalls + trace.codegraphCalls + trace.memoryCalls} calls
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-3">
                                    {/* Adapter 1: agentmemory */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.memoryCalls > 0
                                                ? 'bg-amber-950/20 border-amber-400/80 shadow-[0_0_12px_rgba(245,158,11,0.15)] ring-1 ring-amber-400/40'
                                                : 'bg-surface-raised/40 border-surface-border/60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-amber-300">
                                                3.1 agentmemory-mcp
                                            </span>
                                            <span className="text-[10px] font-mono text-amber-400 px-1.5 py-0.2 bg-amber-500/10 rounded">
                                                {trace.memoryCalls} calls
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Delta-scoped episodic recall via <code className="text-amber-200">memory_smart_search</code> with <code className="text-amber-200">excludeSessionId</code> (no same-session echo).
                                        </p>
                                    </div>

                                    {/* Adapter 2: docgraph */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.docgraphCalls > 0
                                                ? 'bg-emerald-950/20 border-emerald-400/80 shadow-[0_0_12px_rgba(16,185,129,0.15)] ring-1 ring-emerald-400/40'
                                                : 'bg-surface-raised/40 border-surface-border/60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-emerald-300">
                                                3.2 docgraph-cli
                                            </span>
                                            <span className="text-[10px] font-mono text-emerald-400 px-1.5 py-0.2 bg-emerald-500/10 rounded">
                                                {trace.docgraphCalls} calls
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Normative slicing on Agent Zone first: only <code className="text-emerald-200">## Invariants</code>, <code className="text-emerald-200">INV-*</code>, [!CRITICAL]; flags <code className="text-emerald-200">specDebt</code> on legacy prose.
                                        </p>
                                    </div>

                                    {/* Adapter 3: codegraph */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.codegraphCalls > 0
                                                ? 'bg-cyan-950/20 border-cyan-400/80 shadow-[0_0_12px_rgba(6,182,212,0.15)] ring-1 ring-cyan-400/40'
                                                : 'bg-surface-raised/40 border-surface-border/60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-cyan-300">
                                                3.3 codegraph-cli
                                            </span>
                                            <span className="text-[10px] font-mono text-cyan-400 px-1.5 py-0.2 bg-cyan-500/10 rounded">
                                                {trace.codegraphCalls} calls
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Maps symbol AST trees, call hierarchies, and blast radius in 1 round-trip via <code className="text-cyan-200">codegraph_explore</code>.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ========================================================================= */}
                        {/* STEP 4: EVIDENCE SUFFICIENCY GATE */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-amber-500/70 text-amber-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(245,158,11,0.3)]">
                                    4
                                </div>
                                <div className="w-0.5 flex-1 bg-gradient-to-b from-amber-500/50 to-indigo-500/50 my-1" />
                            </div>

                            <div className="flex-1 bg-surface-card/90 border border-amber-500/40 rounded-xl p-4 shadow-sm hover:border-amber-400/60 transition-all">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
                                            Step 4 · Sufficiency Gate & HMAC Receipt
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                            score = (lawRatio × 0.55) + (readRatio × 0.45) · SUFFICIENT iff score ≥ T_high and 0 gaps
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] font-mono text-slate-300">
                                            Score: <strong className="text-white">{trace.score}%</strong>
                                        </span>
                                        <Badge tone={trace.isSufficient ? 'ok' : trace.isPartial ? 'warn' : 'danger'}>
                                            {trace.sufficiency.toUpperCase()}
                                        </Badge>
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-3">
                                    {/* Gate Option 1: SUFFICIENT */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.isSufficient
                                                ? 'bg-emerald-950/25 border-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.2)] ring-1 ring-emerald-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                                                Sufficient (Green Flag)
                                            </span>
                                            {trace.isSufficient && <Badge tone="ok">PASS</Badge>}
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Score ≥ T_high and 0 open gaps (or promoted by <code className="text-emerald-300">recordGapToolUse</code> when all gaps close). Mints HMAC-SHA256 receipt in <code className="text-emerald-300">.eso-bundle-stamp.json</code>; <code>guard-write.py</code> verifies signature, TTL and Brain Stamp before unlocking writes.
                                        </p>
                                    </div>

                                    {/* Gate Option 2: INSUFFICIENT */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.isInsufficient
                                                ? 'bg-rose-950/25 border-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.2)] ring-1 ring-rose-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-rose-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-rose-400" />
                                                Insufficient (Hard Block)
                                            </span>
                                            {trace.isInsufficient && <Badge tone="danger">BLOCK</Badge>}
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Fail-closed mode: Prohibits code writes until agent loops back to Step 3 to close gaps (<code className="text-rose-300">MISSING_LAW</code>, etc.).
                                        </p>
                                    </div>

                                    {/* Gate Option 3: CONSENT / ADVISORY */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.isPartial
                                                ? 'bg-amber-950/25 border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.2)] ring-1 ring-amber-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-amber-400" />
                                                Consent / Advisory
                                            </span>
                                            {trace.isPartial && <Badge tone="warn">CONSENT</Badge>}
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Enters <code className="text-amber-300">ConsentPending</code> state or injects advisory prompt block if in hint/observe mode.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ========================================================================= */}
                        {/* STEP 5: BRAIN TIER ROUTING */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-indigo-500/70 text-indigo-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(99,102,241,0.3)]">
                                    5
                                </div>
                                <div className="w-0.5 flex-1 bg-gradient-to-b from-indigo-500/50 to-teal-500/50 my-1" />
                            </div>

                            <div className="flex-1 bg-surface-card/90 border border-indigo-500/40 rounded-xl p-4 shadow-sm hover:border-indigo-400/60 transition-all">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                                            Step 5 · Cognitive Allocation
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                            (Direct IDE · Brain Flash · Brain Pro)
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] text-slate-400">Active Tier:</span>
                                        <Badge
                                            tone={
                                                trace.activeBrain === 'pro'
                                                    ? 'warn'
                                                    : trace.activeBrain === 'flash'
                                                    ? 'info'
                                                    : 'ok'
                                            }
                                        >
                                            {trace.activeBrain === 'pro'
                                                ? 'Brain Pro (DeepSeek Pro)'
                                                : trace.activeBrain === 'flash'
                                                ? 'Brain Flash (DeepSeek Flash)'
                                                : 'Zero Brain (IDE Dispatcher)'}
                                        </Badge>
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-3">
                                    {/* Tier 1: Zero Brain */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.activeBrain === 'zero'
                                                ? 'bg-emerald-950/20 border-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.2)] ring-1 ring-emerald-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-emerald-300">
                                                5.1 Direct IDE
                                            </span>
                                            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded">
                                                0 Brain Tokens
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            IDE model reasons and patches directly (<code>.direct-mode</code> sentinel, Brain Stamp <code>via: direct_ide</code>).
                                        </p>
                                    </div>

                                    {/* Tier 2: Brain Flash */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.activeBrain === 'flash'
                                                ? 'bg-sky-950/20 border-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.2)] ring-1 ring-sky-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-sky-300">
                                                5.2 Brain Flash
                                            </span>
                                            <span className="text-[10px] font-mono text-sky-400 bg-sky-500/10 px-1.5 py-0.2 rounded">
                                                DeepSeek Flash
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Default workhorse: implementation, bugfixes, TDD, WBS slices with AC, and Jira enrichment.
                                        </p>
                                    </div>

                                    {/* Tier 3: Brain Pro */}
                                    <div
                                        className={`rounded-xl p-3 border transition-all ${
                                            trace.activeBrain === 'pro'
                                                ? 'bg-purple-950/20 border-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.2)] ring-1 ring-purple-400/50'
                                                : 'bg-surface-raised/40 border-surface-border/60 opacity-60'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-bold text-purple-300">
                                                5.3 Brain Pro
                                            </span>
                                            <span className="text-[10px] font-mono text-purple-400 bg-purple-500/10 px-1.5 py-0.2 rounded">
                                                DeepSeek Pro
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-slate-300 m-0 leading-relaxed">
                                            Exception tier: greenfield bounded contexts, cross-module money/tenant redesign, or law conflicts.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ========================================================================= */}
                        {/* STEP 6 & 7: SAFE EXECUTION & KNOWLEDGE DISTILLATION */}
                        {/* ========================================================================= */}
                        <div className="flow-step flex items-stretch gap-4">
                            <div className="flow-step-badge flex flex-col items-center">
                                <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-teal-500/70 text-teal-400 flex items-center justify-center font-bold text-xs shadow-[0_0_12px_rgba(20,184,166,0.3)]">
                                    6-7
                                </div>
                            </div>

                            <div className="flex-1 grid grid-cols-2 gap-4">
                                {/* Step 6: Safe Execution */}
                                <div className="bg-surface-card/90 border border-teal-500/40 rounded-xl p-4 shadow-sm hover:border-teal-400/60 transition-all">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-teal-400">
                                            Step 6 · Safe Execution & Range-Read
                                        </span>
                                        <span className="text-[11px] font-mono text-teal-300 bg-teal-500/10 px-2 py-0.5 rounded">
                                            {trace.toolCallsCount} tools · {trace.editCallsCount} edits
                                        </span>
                                    </div>
                                    <ul className="text-[11px] text-slate-300 space-y-1.5 m-0 pl-4 list-disc">
                                        <li>
                                            <strong className="text-slate-200">Surgical Patches:</strong> Minimal <code className="text-teal-300">replace_file_content</code> edits, preserving comments.
                                        </li>
                                        <li>
                                            <strong className="text-slate-200">Deterministic Verify:</strong> <code className="text-teal-300">dotnet test</code> / <code className="text-teal-300">node --test</code> / selfcheck.
                                        </li>
                                        <li>
                                            <strong className="text-slate-200">Jira Rollup:</strong> In Progress (21) → Human In Review (31) + Story rollup.
                                        </li>
                                    </ul>
                                </div>

                                {/* Step 7: Knowledge Distillation */}
                                <div
                                    className={`rounded-xl p-4 border transition-all ${
                                        trace.memorySaved
                                            ? 'bg-emerald-950/20 border-emerald-400/80 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                                            : 'bg-surface-card/90 border-slate-700/60'
                                    }`}
                                >
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                                            Step 7-8 · Distillation & Handoff
                                        </span>
                                        {trace.memorySaved ? (
                                            <Badge tone="ok">Memory Saved</Badge>
                                        ) : (
                                            <span className="text-[11px] text-slate-400">Episodic memory</span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-slate-300 m-0 leading-relaxed mb-2">
                                        Persists verified decisions, lessons, and touched symbols via <code className="text-emerald-300">memory_save</code>, then hands off with file links and <code className="text-emerald-300">READY_FOR_HUMAN_REVIEW</code>.
                                    </p>
                                    <div className="p-2 rounded bg-surface-raised/80 border border-surface-border text-[10px] font-mono text-slate-400 flex items-center justify-between">
                                        <span>Next turn inherits context automatically</span>
                                        <span className="text-emerald-400">Step 7 → Step 3.1</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
