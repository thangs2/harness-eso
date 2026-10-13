import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDecisions } from '@/shared/api/client';
import type { DecisionListItem } from '@/shared/api/types';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { EmptyState, ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';

export function DecisionsPage() {
    const [items, setItems] = useState<DecisionListItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        fetchDecisions({ limit: 80 })
            .then((res) => {
                setItems(res.items);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
        return subscribeObserveRefresh(() => load());
    }, [load]);

    return (
        <section>
            <PageHeader title="Decisions" description="Facade ledger — route, guard, Jev lane." />
            {loading && items.length === 0 && <LoadingState label="Loading decisions…" />}
            {error && <ErrorBanner message={`Could not load decisions: ${error}`} />}
            {!loading && !error && items.length === 0 && (
                <EmptyState title="No ledger rows" hint="turn_start and guard events appear after hooks run." />
            )}
            {items.length > 0 && (
                <div className="obs-table-wrap">
                    <table className="obs-table">
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Event</th>
                                <th>Verdict</th>
                                <th>Winner</th>
                                <th>Request</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((row) => (
                                <tr key={row.id}>
                                    <td className="obs-sub whitespace-nowrap">{row.createdAt ?? '—'}</td>
                                    <td className="obs-mono">{row.eventType}</td>
                                    <td>{row.enforcedVerdict ?? '—'}</td>
                                    <td>{row.resolverWinner ?? '—'}</td>
                                    <td>
                                        {row.requestId ? (
                                            <Link to={`/requests/${row.requestId}`}>
                                                {row.userQuery?.slice(0, 40) ?? row.requestId}
                                            </Link>
                                        ) : (
                                            '—'
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
