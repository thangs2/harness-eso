import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { RequestTreeView } from '@/features/tree/RequestTreeView';
import { fetchRequestDetail, fetchRequests } from '@/shared/api/client';
import type { RequestDetailResponse, RequestListItem } from '@/shared/api/types';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';

export function TreePage() {
    const { requestId: routeId } = useParams<{ requestId?: string }>();
    const [searchParams, setSearchParams] = useSearchParams();
    const pickerQ = searchParams.get('q') || '';

    const [picker, setPicker] = useState<RequestListItem[]>([]);
    const [detail, setDetail] = useState<RequestDetailResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const activeId = routeId || searchParams.get('requestId') || '';

    const loadPicker = useCallback(() => {
        fetchRequests({ limit: 80, q: pickerQ || undefined })
            .then((res) => setPicker(res.items))
            .catch(() => setPicker([]));
    }, [pickerQ]);

    const loadDetail = useCallback(() => {
        if (!activeId) {
            setDetail(null);
            return;
        }
        setLoading(true);
        fetchRequestDetail(activeId)
            .then((res) => {
                setDetail(res);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, [activeId]);

    useEffect(() => {
        loadPicker();
        return subscribeObserveRefresh(() => loadPicker());
    }, [loadPicker]);

    useEffect(() => {
        loadDetail();
        return subscribeObserveRefresh(() => loadDetail());
    }, [loadDetail]);

    return (
        <section>
            <PageHeader
                title="Tree"
                description="Stage / tool / hook timeline for one request. Pick a turn below or open from Requests."
            />
            <div className="tree-picker mb-4">
                <label className="grid gap-1 text-sm max-w-xl">
                    Filter turns
                    <input
                        type="search"
                        className="obs-search"
                        value={pickerQ}
                        onChange={(e) => {
                            const next = e.target.value;
                            setSearchParams(next ? { q: next } : {});
                        }}
                        placeholder="Search user query…"
                    />
                </label>
                <div className="obs-table-wrap mt-3 max-h-48 overflow-y-auto">
                    <table className="obs-table">
                        <thead>
                            <tr>
                                <th>Turn</th>
                                <th>Query</th>
                            </tr>
                        </thead>
                        <tbody>
                            {picker.map((row) => (
                                <tr key={row.id} className={row.id === activeId ? 'tree-picker-row--active' : ''}>
                                    <td>
                                        <Link to={`/tree/${row.id}`}>#{row.boundaryIndex}</Link>
                                    </td>
                                    <td>
                                        <Link to={`/tree/${row.id}`}>{row.userQuery?.slice(0, 64) || row.id}</Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {!activeId && <p className="obs-sub">Select a request to expand the event tree.</p>}
            {activeId && loading && !detail && <LoadingState label="Loading tree…" />}
            {error && <ErrorBanner message={error} />}
            {activeId && detail && <RequestTreeView detail={detail} requestId={activeId} />}
        </section>
    );
}
