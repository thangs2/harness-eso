import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCalls } from '@/shared/api/client';
import type { CallListItem } from '@/shared/api/types';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { EmptyState, ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';

export function CallsPage() {
    const [items, setItems] = useState<CallListItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        fetchCalls({ limit: 80 })
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
            <PageHeader title="Calls" description="LLM / assistant messages linked to requests." />
            {loading && items.length === 0 && <LoadingState label="Loading calls…" />}
            {error && <ErrorBanner message={`Could not load calls: ${error}`} />}
            {!loading && !error && items.length === 0 && (
                <EmptyState title="No calls ingested" hint="Transcript ingest fills this after agent turns." />
            )}
            {items.length > 0 && (
                <div className="obs-table-wrap">
                    <table className="obs-table">
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Request</th>
                                <th>Kind</th>
                                <th>Tools</th>
                                <th>Preview</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((row) => (
                                <tr key={row.id}>
                                    <td className="obs-sub whitespace-nowrap">{row.requestStartedAt ?? '—'}</td>
                                    <td>
                                        {row.requestId ? (
                                            <Link to={`/requests/${row.requestId}`}>
                                                {row.userQuery?.slice(0, 48) ?? row.requestId}
                                            </Link>
                                        ) : (
                                            '—'
                                        )}
                                    </td>
                                    <td>{row.kind ?? '—'}</td>
                                    <td>{row.toolCount ?? 0}</td>
                                    <td className="obs-sub">{row.preview?.slice(0, 100) ?? '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
