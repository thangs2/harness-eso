import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BrainCanvas } from '@/features/brain/BrainCanvas';
import { BrainLegend } from '@/features/brain/BrainLegend';
import { BrainNodeCard } from '@/features/brain/BrainNodeCard';
import { BRAIN_UNDATED_LABEL, BRAIN_VIEWS, filterBrainGraph, layoutBrain, type BrainView } from '@/features/brain/brainLayout';
import { BRAIN_TUNING } from '@/features/brain/brainTuning';
import { cameraForNode, fitCamera, type Camera } from '@/features/brain/brainProjection';
import { fetchBrainGraph } from '@/shared/api/client';
import type { BrainGraphDocument, BrainKind } from '@/shared/api/types';
import { ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const CANVAS_HEIGHT = 560;

function asView(value: string | null): BrainView {
    return BRAIN_VIEWS.some((v) => v.id === value) ? (value as BrainView) : 'rings';
}

/**
 * The Brain page: the whole workspace in six views, drawn from `/api/brain/graph.json`.
 *
 * It replaced the old `/graph` tab on purpose. That tab rendered a static route artifact that was
 * never a contract of this package; per-request graphs still live where they belong, in the
 * request-detail Graph/Topology tabs (G6). This page answers a different question — what the
 * workspace looks like as a whole — so it does not touch the detail-page graph code.
 */
export function BrainPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const view = asView(searchParams.get('view'));
    const selectedId = searchParams.get('node');

    const [doc, setDoc] = useState<BrainGraphDocument | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
    const [size, setSize] = useState({ width: 960, height: CANVAS_HEIGHT });
    const [names, setNames] = useState(true);
    const [motion, setMotion] = useState(true);
    const [areaFilter, setAreaFilter] = useState<string | null>(null);
    const [kindFilter, setKindFilter] = useState<BrainKind | null>(null);
    const [query, setQuery] = useState('');
    const [fitNonce, setFitNonce] = useState(0);
    const wrapRef = useRef<HTMLDivElement>(null);

    const patch = (next: Record<string, string | null>) => {
        const params = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(next)) {
            if (value == null) params.delete(key);
            else params.set(key, value);
        }
        setSearchParams(params, { replace: true });
    };

    useEffect(() => {
        let cancelled = false;
        fetchBrainGraph()
            .then((data) => {
                if (cancelled) return;
                setDoc(data);
                setError(null);
            })
            .catch((err: Error) => {
                if (cancelled) return;
                setDoc(null);
                setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const apply = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: Math.max(320, Math.round(rect.width)), height: CANVAS_HEIGHT });
        };
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Isolation is a filter over the same node set, so the root always stays for orientation.
    const filtered = useMemo(
        () => filterBrainGraph(doc, { area: areaFilter, kind: kindFilter }),
        [areaFilter, doc, kindFilter],
    );

    const layout = useMemo(() => (filtered ? layoutBrain(view, filtered) : null), [filtered, view]);

    // One place decides the camera after a view switch, a filter change or a resize. The camera
    // itself is component state (not storage): the page never persists what it shows.
    useEffect(() => {
        if (!layout) return;
        setCamera(fitCamera(layout.bounds, size));
    }, [fitNonce, layout, size]);

    const selected = doc?.nodes.find((node) => node.id === selectedId) ?? null;
    const hit = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (!doc || term.length < 2) return [];
        return doc.nodes
            .filter(
                (node) =>
                    node.label.toLowerCase().includes(term) ||
                    (node.path ?? '').toLowerCase().includes(term) ||
                    (node.note ?? '').toLowerCase().includes(term),
            )
            .slice(0, 8);
    }, [doc, query]);

    return (
        <section>
            <PageHeader
                title="Brain"
                description={
                    <>
                        Panorama of this workspace, composed from the observe DB. Per-request graphs and
                        topology live in the request detail tabs. Nothing on this page is stored — every
                        dot is read from a row.
                    </>
                }
                actions={
                    <>
                        <button type="button" className="obs-btn obs-btn--ghost" onClick={() => setFitNonce((n) => n + 1)}>
                            Fit
                        </button>
                        <button
                            type="button"
                            className={`obs-btn obs-btn--ghost${names ? ' flow-tab--on' : ''}`}
                            onClick={() => setNames((v) => !v)}
                            aria-pressed={names}
                        >
                            Names
                        </button>
                        <button
                            type="button"
                            className={`obs-btn obs-btn--ghost${motion ? ' flow-tab--on' : ''}`}
                            onClick={() => setMotion((v) => !v)}
                            aria-pressed={motion}
                        >
                            Motion
                        </button>
                        <button
                            type="button"
                            className="obs-btn obs-btn--ghost"
                            onClick={() => {
                                const el = wrapRef.current;
                                if (!el) return;
                                if (document.fullscreenElement) void document.exitFullscreen();
                                else void el.requestFullscreen?.();
                            }}
                        >
                            Full screen
                        </button>
                    </>
                }
            />

            {loading && <LoadingState label="Building the brain…" />}
            {error && <ErrorBanner message={`${error} — the graph is served by /api/brain/graph.json.`} />}

            {doc && !loading && doc.nodes.length === 0 && (
                <Panel title="Nothing to draw yet" lede="The graph is empty because no source row produced a node." accent="#fbbf24">
                    <ul className="m-0 pl-5">
                        {doc.meta.omitted.map((entry) => (
                            <li key={entry.layer}>
                                <span className="obs-mono">{entry.layer}</span> — {entry.reason}
                            </li>
                        ))}
                        {doc.meta.sources.map((source) => (
                            <li key={source.source}>
                                <span className="obs-mono">{source.source}</span> —{' '}
                                {source.present ? `${source.rows} row(s)` : 'absent'}
                            </li>
                        ))}
                    </ul>
                </Panel>
            )}

            {doc && filtered && layout && doc.nodes.length > 0 && (
                <>
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                        {BRAIN_VIEWS.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={`obs-btn obs-btn--ghost flow-tab${view === entry.id ? ' flow-tab--on' : ''}`}
                                onClick={() => patch({ view: entry.id })}
                                title={entry.hint}
                            >
                                {entry.label}
                            </button>
                        ))}
                        <div className="relative ml-auto" style={{ minWidth: 240 }}>
                            <input
                                className="obs-search w-full"
                                placeholder="Search label, path or note…"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                            {hit.length > 0 ? (
                                <ul
                                    className="obs-panel absolute z-10 m-0 mt-1 p-2 list-none"
                                    style={{ right: 0, left: 0, maxHeight: 260, overflowY: 'auto' }}
                                >
                                    {hit.map((node) => (
                                        <li key={node.id}>
                                            <button
                                                type="button"
                                                className="obs-btn obs-btn--ghost w-full text-left"
                                                onClick={() => {
                                                    patch({ node: node.id });
                                                    const point = layout.positions.get(node.id);
                                                    if (point) setCamera(cameraForNode(point, size));
                                                    setQuery('');
                                                }}
                                            >
                                                <span className="obs-mono text-xs">{node.label}</span>
                                                <span className="obs-sub m-0 ml-2">{node.kind}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </div>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                        <div ref={wrapRef} className="obs-panel" style={{ padding: 8, minWidth: 0 }}>
                            <BrainCanvas
                                doc={filtered}
                                layout={layout}
                                size={size}
                                camera={camera}
                                onCamera={setCamera}
                                selectedId={selectedId}
                                onSelect={(id) => patch({ node: id })}
                                names={names}
                                motion={motion}
                                height={CANVAS_HEIGHT}
                            />
                            <p className="obs-sub m-0 mt-2 px-1">
                                {doc.legend}
                                {view === 'timeline' ? ` · ${BRAIN_UNDATED_LABEL}` : null}
                            </p>
                        </div>
                        <div className="flex flex-col gap-3">
                            {selected ? (
                                <BrainNodeCard
                                    node={selected}
                                    onClose={() => patch({ node: null })}
                                    onFlyTo={() => {
                                        const point = layout.positions.get(selected.id);
                                        if (point) setCamera(cameraForNode(point, size));
                                    }}
                                />
                            ) : null}
                            <div className="obs-panel">
                                <BrainLegend
                                    doc={doc}
                                    areaFilter={areaFilter}
                                    kindFilter={kindFilter}
                                    onArea={setAreaFilter}
                                    onKind={setKindFilter}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-4">
                        <Panel
                            title="Coverage"
                            lede="What this graph is built from, what it could not include, and what was capped."
                            badges={<span className="obs-pill">{doc.meta.sources.length} sources</span>}
                            accent="#60a5fa"
                        >
                            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                                <div>
                                    <p className="obs-sub m-0 mb-1">Sources</p>
                                    <ul className="m-0 pl-4">
                                        {doc.meta.sources.map((source) => (
                                            <li key={source.source}>
                                                <span className="obs-mono">{source.source}</span>:{' '}
                                                {source.present ? source.rows : 'absent'}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                <div>
                                    <p className="obs-sub m-0 mb-1">Omitted</p>
                                    {doc.meta.omitted.length === 0 ? (
                                        <p className="obs-sub m-0">nothing omitted</p>
                                    ) : (
                                        <ul className="m-0 pl-4">
                                            {doc.meta.omitted.map((entry) => (
                                                <li key={entry.layer}>
                                                    <span className="obs-mono">{entry.layer}</span> — {entry.reason}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div>
                                    <p className="obs-sub m-0 mb-1">Capped (shown / total)</p>
                                    {doc.meta.truncated.length === 0 ? (
                                        <p className="obs-sub m-0">no cap reached</p>
                                    ) : (
                                        <ul className="m-0 pl-4">
                                            {doc.meta.truncated.map((entry) => (
                                                <li key={entry.kind}>
                                                    <span className="obs-mono">{entry.kind}</span>: {entry.shown} /{' '}
                                                    {entry.total}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                            <p className="obs-sub m-0 mt-3">
                                built <span className="obs-mono">{doc.meta.builtAt}</span> from{' '}
                                <span className="obs-mono">{doc.meta.project.label}</span>
                                {doc.nodes.length > BRAIN_TUNING.maxRenderNodes
                                    ? ` · render capped to ${BRAIN_TUNING.maxRenderNodes} of ${doc.nodes.length} nodes`
                                    : ''}
                            </p>
                        </Panel>
                    </div>
                </>
            )}
        </section>
    );
}
