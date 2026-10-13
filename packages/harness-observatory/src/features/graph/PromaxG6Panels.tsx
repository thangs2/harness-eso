import { useEffect, useMemo, useRef } from 'react';
import type { FlowGraphVm } from '@/shared/api/types';
import { comboCanvasHeight } from './blueprintLayout';
import { MountLedger } from './mountLedger';
import { PromaxFlowLegend } from './PromaxFlowLegend';
import {
    mountPromaxBlueprintCombo,
    mountPromaxDesignGraph,
    mountPromaxFlowGraph,
} from './promaxG6Mount';

/** Minimal shape the ledger needs from a mounted canvas. */
type LedgerGraph = { destroy: () => void };

const DEFAULT_COMBOS = [
    { id: 'c1', data: { label: '§1 System context' } },
    { id: 'c2', data: { label: '§2 Layer stack L0→L4' } },
    { id: 'c3', data: { label: '§3 Decision Facade' } },
    { id: 'c4', data: { label: '§4 Policy · jev.mode' } },
];

export function PromaxFlowGraphPanel({
    graph,
    emptyLabel = 'No tool calls recorded for this request',
}: {
    graph: FlowGraphVm | null | undefined;
    emptyLabel?: string;
}) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !graph?.nodes?.length) return;

        let inst: { destroy: () => void } | null = null;
        let cancelled = false;
        host.innerHTML = '';

        mountPromaxFlowGraph(host, graph)
            .then((g) => {
                if (cancelled) {
                    g?.destroy();
                    return;
                }
                inst = g;
            })
            .catch(() => {
                /* render failure */
            });

        return () => {
            cancelled = true;
            inst?.destroy();
            inst = null;
        };
    }, [graph]);

    if (!graph?.nodes?.length) {
        return <p className="obs-sub m-0">{emptyLabel}</p>;
    }

    return (
        <div className="promax-flow-panel">
            <div ref={hostRef} className="promax-d-graph g6-graph-host g6-graph-host--flow" />
            <PromaxFlowLegend graph={graph} />
        </div>
    );
}

export function PromaxDesignGraphPanel({
    graph,
    height = 480,
    emptyLabel = 'No graph data',
    legend,
}: {
    graph: FlowGraphVm | null | undefined;
    height?: number;
    emptyLabel?: string;
    legend?: string;
}) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !graph?.nodes?.length) return;

        let inst: { destroy: () => void } | null = null;
        let cancelled = false;
        host.innerHTML = '';
        host.style.minHeight = `${height}px`;

        mountPromaxDesignGraph(host, graph)
            .then((g) => {
                if (cancelled) {
                    g?.destroy();
                    return;
                }
                inst = g;
            })
            .catch(() => {
                /* ignore */
            });

        return () => {
            cancelled = true;
            inst?.destroy();
        };
    }, [graph, height]);

    if (!graph?.nodes?.length) {
        return <p className="obs-sub m-0">{emptyLabel}</p>;
    }

    return (
        <div className="promax-design-panel">
            {legend ? <p className="flow-graph-legend m-0 mb-2">{legend}</p> : null}
            <div className="chips mb-2">
                <span className="chip">gray = design</span>
                <span className="chip promax-chip-active">green = this request</span>
            </div>
            <div ref={hostRef} className="g6-graph-host" />
        </div>
    );
}

export function PromaxBlueprintGrid({ designGraph }: { designGraph: FlowGraphVm | null | undefined }) {
    const comboDefs = useMemo(
        () => (designGraph?.combos?.length ? designGraph.combos : DEFAULT_COMBOS),
        [designGraph?.combos],
    );
    const hostRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
    /**
     * Every mounted canvas, tagged with the run that created it. See `mountLedger.ts` for why a
     * shared `mountedKeyRef` was not enough: StrictMode's simulated unmount cleared it while the
     * first run was still awaiting `import('@antv/g6')`, so the second run mounted a duplicate
     * graph into every host and the two overlapped invisibly until a drag.
     */
    const ledgerRef = useRef<MountLedger<LedgerGraph> | null>(null);
    if (!ledgerRef.current) ledgerRef.current = new MountLedger<LedgerGraph>();
    const ledger = ledgerRef.current;

    /**
     * Content key. The effect below destroys and re-mounts every canvas on each run, so it must
     * fire only when the graph CONTENT changes — not on every parent render. Depending on the
     * `designGraph` / `combos` object identities re-ran the effect faster than a mount could
     * finish, leaving all four hosts empty.
     */
    const graphKey = useMemo(
        () =>
            `${(designGraph?.nodes ?? []).map((n) => `${n.id}:${n.combo}`).join(',')}|${(
                designGraph?.edges ?? []
            )
                .map((e) => `${e.source}>${e.target}`)
                .join(',')}`,
        [designGraph],
    );

    const combos = useMemo(() => {
        const nodes = designGraph?.nodes ?? [];
        const edges = designGraph?.edges ?? [];
        const comboOf = new Map(nodes.map((n) => [n.id, n.combo]));
        return comboDefs.map((c) => {
            const own = nodes.filter((n) => n.combo === c.id);
            const ownIds = new Set(own.map((n) => n.id));
            const boundary: typeof own = [];
            for (const e of edges) {
                const s = ownIds.has(e.source);
                const t = ownIds.has(e.target);
                if (s === t) continue; // both in, or both out
                const farId = s ? e.target : e.source;
                const far = nodes.find((n) => n.id === farId);
                if (far && comboOf.get(far.id) !== c.id && !boundary.some((b) => b.id === far.id)) {
                    boundary.push({ ...far, data: { ...far.data, boundary: true } });
                }
            }
            const all = [...own, ...boundary];
            const ids = new Set(all.map((n) => n.id));
            const localEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
            return {
                combo: c,
                nodes: all,
                edges: localEdges,
                height: comboCanvasHeight(all, localEdges),
            };
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `graphKey` IS the content of `designGraph`
    }, [graphKey, comboDefs]);

    useEffect(() => {
        // Anything mounted by an earlier run belongs to superseded content.
        const token = ledger.begin();

        const run = async () => {
            /*
             * Yield one macrotask so React has committed the inline heights, then mount.
             *
             * This used to wait on `requestAnimationFrame`, which is throttled — sometimes
             * paused entirely — for a tab that is not foreground. In that state the wait never
             * resolved, so `run()` stalled for the rest of the session and the four panels
             * stayed empty while the flow and ESO graphs (which do not use rAF) rendered fine.
             * A timer is not tied to paint.
             */
            await new Promise<void>((r) => setTimeout(r, 0));
            for (const { combo, nodes, edges, height } of combos) {
                /*
                 * Checked BEFORE touching a host: a superseded run must not clear a canvas the
                 * current run has already mounted. Since `begin()` bumps the token synchronously
                 * while a stale run is parked on an `await`, this is what stops the second
                 * StrictMode invocation from tearing down the first invocation's output.
                 */
                if (ledger.isStale(token)) return;

                const host = hostRefs.current.get(combo.id);
                if (!host) continue;
                host.style.height = `${height}px`;
                host.innerHTML = '';
                try {
                    const g = await mountPromaxBlueprintCombo(host, nodes, edges);
                    if (!g) continue;
                    // Superseded while this mount was in flight — `keep` destroys it rather than
                    // leaving an untracked graph rendering over the live one.
                    ledger.keep(token, { destroy: () => g.destroy() });
                } catch (err) {
                    host.innerHTML = `<div class="g6-fallback">graph failed: ${String(
                        (err as Error)?.message ?? err,
                    )}</div>`;
                }
            }
        };

        if (designGraph?.nodes?.length) void run();

        return () => {
            /*
             * Invalidate this run and drop everything it mounted. StrictMode's simulated unmount
             * lands here too, which is why invalidation belongs in the cleanup rather than in a
             * shared key: the next run owns the token and is the only one allowed to publish.
             */
            ledger.invalidate();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `graphKey` is the content of `designGraph`; `combos` derives from it
    }, [graphKey]);

    if (!designGraph?.nodes?.length) {
        return (
            <p className="obs-sub m-0">
                No <code>decision_ledger</code> design graph for this request — ingest after Facade runs.
            </p>
        );
    }

    return (
        <div className="promax-s1-stack">
            <div className="chips mb-2">
                <span className="chip">gray = 19 §V5/V3 taxonomy</span>
                <span className="chip promax-chip-active">green = this request</span>
            </div>
            <div className="promax-s1-grid">
                {combos.map(({ combo: c, height }) => (
                    <div key={c.id} className="promax-s1-panel">
                        <div className="promax-s1-panel-title">{c.data?.label ?? c.id}</div>
                        <div
                            ref={(el) => {
                                hostRefs.current.set(c.id, el);
                            }}
                            className="promax-s1-graph-host"
                            style={{ height: `${height}px` }}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
