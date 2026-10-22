import { useCallback, useEffect, useState } from 'react';
import { fetchGateEvents, fetchGateSummary } from '@/shared/api/client';
import type { GateEvent, GateSummaryResponse } from '@/shared/api/types';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { EmptyState, ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';

/**
 * Gate — what the runtime refused, and why.
 *
 * The host logs nothing when it blocks a tool or a step, so this page reads the decisions the plugin
 * wrote to product state. Without it the only account of a blocked write was a `tail` command.
 */
export function GatePage() {
    const [items, setItems] = useState<GateEvent[]>([]);
    const [summary, setSummary] = useState<GateSummaryResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        Promise.all([fetchGateEvents({ limit: 100 }), fetchGateSummary()])
            .then(([events, stats]) => {
                setItems(events.items);
                setSummary(stats);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
        return subscribeObserveRefresh(() => load());
    }, [load]);

    const kindCounts = summary?.byKind ?? [];

    return (
        <section>
            <PageHeader
                title="Gate"
                description="Decisions the runtime made to refuse a prompt or a tool call, newest first."
            />
            {loading && items.length === 0 && <LoadingState label="Loading gate decisions…" />}
            {error && <ErrorBanner message={`Could not load gate decisions: ${error}`} />}

            {summary && (
                <div className="obs-grid">
                    {kindCounts.length === 0 ? (
                        <div className="obs-card">
                            <div className="obs-card-title">No decisions recorded</div>
                            <p className="obs-muted">
                                The trail is empty or no decision names this project. Trail file:{' '}
                                <code>{summary.trailPath ?? 'not configured'}</code>
                            </p>
                        </div>
                    ) : (
                        kindCounts.map((row) => (
                            <div className="obs-card" key={row.kind}>
                                <div className="obs-card-title">{row.kind}</div>
                                <div className="obs-metric">{row.n}</div>
                            </div>
                        ))
                    )}
                </div>
            )}

            {!loading && !error && items.length === 0 && (
                <EmptyState
                    title="No gate decisions ingested"
                    hint="A blocked write or a refused prompt appends a line to ~/.harness/eso-blockers.jsonl; ingest copies it here."
                />
            )}

            {items.length > 0 && (
                <div className="obs-table-wrap">
                    <table className="obs-table">
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Kind</th>
                                <th>Host</th>
                                <th>Tool</th>
                                <th>Target</th>
                                <th>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((row) => (
                                <tr key={row.id}>
                                    <td className="obs-mono">{row.at ?? '—'}</td>
                                    <td>{row.kind}</td>
                                    <td>{row.host ?? '—'}</td>
                                    <td>{row.tool ?? '—'}</td>
                                    <td className="obs-mono">{row.ref ?? '—'}</td>
                                    <td>{row.detail ?? row.blockers?.[0]?.detail ?? '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
