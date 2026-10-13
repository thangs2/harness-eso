import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RouteMapPanel } from '@/features/graph/RouteMapPanel';
import { FlowGraphSvg } from '@/features/graph/FlowGraphSvg';
import { fetchDecisionFlow, fetchRouteGraph } from '@/shared/api/client';
import type { RouteGraphDocument } from '@/shared/api/types';
import { ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';

export function RouteGraphPage() {
    const [searchParams] = useSearchParams();
    const requestId = searchParams.get('requestId') || '';

    const [doc, setDoc] = useState<RouteGraphDocument | null>(null);
    const [routeError, setRouteError] = useState<string | null>(null);
    const [routeLoading, setRouteLoading] = useState(true);

    const [flowError, setFlowError] = useState<string | null>(null);
    const [flowGraph, setFlowGraph] = useState<import('@/shared/api/types').DecisionFlowVm | null>(null);

    const loadRoute = useCallback(() => {
        setRouteLoading(true);
        fetchRouteGraph()
            .then((d) => {
                setDoc(d);
                setRouteError(null);
            })
            .catch((e: Error) => {
                setDoc(null);
                setRouteError(e.message);
            })
            .finally(() => setRouteLoading(false));
    }, []);

    useEffect(() => {
        loadRoute();
    }, [loadRoute]);

    useEffect(() => {
        if (!requestId) {
            setFlowGraph(null);
            setFlowError(null);
            return;
        }
        fetchDecisionFlow({ requestId })
            .then((f) => {
                setFlowGraph(f);
                setFlowError(null);
            })
            .catch((e: Error) => setFlowError(e.message));
    }, [requestId]);

    return (
        <section>
            <PageHeader
                title="Graph"
                description="L0 route map from consumer repo artifact. Optional per-request path graph via ?requestId=."
            />
            {requestId && (
                <p className="obs-sub mb-3">
                    Per-request path for <span className="obs-mono">{requestId}</span>
                    {' · '}
                    <Link to="/graph">Clear</Link>
                    {' · '}
                    <Link to={`/requests/${requestId}`}>Detail</Link>
                </p>
            )}

            {routeLoading && <LoadingState label="Loading route map…" />}
            {routeError && (
                <ErrorBanner
                    message={`${routeError}. Build artifact: run harness refresh / build-route-map in the consumer repo (route-graph.json at project root).`}
                />
            )}
            {doc && (
                <div className="obs-panel">
                    <h3 className="text-base font-semibold m-0 mb-3">L0 route map</h3>
                    <RouteMapPanel doc={doc} />
                </div>
            )}

            {requestId && (
                <div className="obs-panel">
                    <h3 className="text-base font-semibold m-0 mb-3">Request decision path</h3>
                    {flowError && <ErrorBanner message={flowError} />}
                    {!flowError && flowGraph && (
                        <FlowGraphSvg graph={flowGraph.graph ?? undefined} emptyLabel="No path graph for this request." />
                    )}
                </div>
            )}
        </section>
    );
}
