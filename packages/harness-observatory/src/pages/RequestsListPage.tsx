import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRequests } from '@/shared/api/client';
import type { RequestListItem } from '@/shared/api/types';
import { groupRequestsByConversation } from '@/shared/requests/groupByConversation';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { Badge } from '@/ui/Badge';
import { EmptyState, ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import {
    fmtTokens,
    formatRelativeWhen,
    formatWhenFull,
    requestStatusTone,
    verdictTone,
} from '@/ui/statusTone';

const PAGE_SIZE = 50;

function RequestTableHead({ showConversation }: { showConversation?: boolean }) {
    return (
        <thead>
            <tr>
                <th className="obs-col-num">#</th>
                <th className="obs-col-when">When</th>
                <th className="obs-col-query">Query</th>
                <th className="obs-col-status">Status</th>
                <th className="obs-col-verdict">Verdict</th>
                <th className="obs-col-model">Model</th>
                <th className="obs-col-tok">In</th>
                <th className="obs-col-tok">Out</th>
                <th className="obs-col-num">Calls</th>
                <th className="obs-col-num">Tools</th>
                <th className="obs-col-checks">Checks</th>
                <th className="obs-col-open">Open</th>
                {showConversation ? <th>Conversation</th> : null}
            </tr>
        </thead>
    );
}

function checksCell(row: RequestListItem) {
    if (row.checksPass == null && row.checksFail == null) return <span className="obs-sub">—</span>;
    const fail = row.checksFail ?? 0;
    const pass = row.checksPass ?? 0;
    if (fail > 0) {
        return (
            <span className="obs-checks obs-checks--fail" title={`${pass} pass · ${fail} fail`}>
                {pass}/{fail}
            </span>
        );
    }
    return (
        <span className="obs-checks obs-checks--ok" title={`${pass} pass`}>
            {pass}
        </span>
    );
}

function RequestRow({ row, showConversation }: { row: RequestListItem; showConversation?: boolean }) {
    const fail = Boolean(row.hasFailures) || (row.checksFail ?? 0) > 0;
    const verdict = row.decisionVerdict ?? '—';

    return (
        <tr className={fail ? 'obs-row--fail' : undefined}>
            <td className="obs-sub tabular-nums obs-col-num">{row.boundaryIndex}</td>
            <td className="obs-sub whitespace-nowrap obs-col-when" title={formatWhenFull(row.startedAt)}>
                {formatRelativeWhen(row.startedAt)}
            </td>
            <td className="obs-col-query">
                <Link to={`/requests/${row.id}`} className="obs-query-link">
                    {row.userQuery?.slice(0, 140) || row.id}
                </Link>
            </td>
            <td className="obs-col-status">
                <Badge tone={requestStatusTone(row.status)} dot>{row.status}</Badge>
                {row.stopStatus && row.stopStatus !== row.status ? (
                    <div className="obs-sub text-[10px] mt-1">
                        <Badge tone={requestStatusTone(row.stopStatus)} dot>{row.stopStatus}</Badge>
                    </div>
                ) : null}
            </td>
            <td className="obs-col-verdict">
                {verdict !== '—' ? (
                    <Badge tone={verdictTone(verdict)}>{verdict}</Badge>
                ) : (
                    <span className="obs-sub">—</span>
                )}
            </td>
            <td className="obs-sub obs-mono obs-col-model" title={row.modelId ?? undefined}>
                {row.modelId?.split('/').pop() ?? '—'}
            </td>
            <td className="obs-sub tabular-nums obs-col-tok">{fmtTokens(row.inputTokens)}</td>
            <td
                className="obs-sub tabular-nums obs-col-tok"
                title={row.tokensEstimated ? 'Estimated from emit_chars ÷ 4' : undefined}
            >
                {fmtTokens(row.outputTokens, row.tokensEstimated)}
            </td>
            <td className="obs-sub tabular-nums obs-col-num">{row.callCount ?? '—'}</td>
            <td className="obs-sub tabular-nums obs-col-num">{row.toolCount ?? '—'}</td>
            <td className="obs-col-checks">{checksCell(row)}</td>
            <td className="obs-col-open">
                <div className="obs-cmd-group">
                    <Link to={`/requests/${row.id}`} className="obs-cmd obs-cmd--primary" title="Detail">
                        →
                    </Link>
                    <Link to={`/tree/${row.id}`} className="obs-cmd">Tree</Link>
                    <Link to={`/graph?requestId=${encodeURIComponent(row.id)}`} className="obs-cmd">
                        Graph
                    </Link>
                </div>
            </td>
            {showConversation ? (
                <td className="obs-mono text-xs">{row.conversationId?.slice(0, 14) ?? '—'}…</td>
            ) : null}
        </tr>
    );
}

export function RequestsListPage() {
    const [items, setItems] = useState<RequestListItem[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [groupByConv, setGroupByConv] = useState(true);
    const [query, setQuery] = useState('');
    const [failuresOnly, setFailuresOnly] = useState(false);

    const load = useCallback((background = false) => {
        if (!background) setLoading(true);
        fetchRequests({
            limit: PAGE_SIZE,
            offset,
            q: query.trim() || undefined,
            hasFailures: failuresOnly || undefined,
        })
            .then((res) => {
                setItems(res.items);
                setTotal(res.page.total);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, [offset, query, failuresOnly]);

    useEffect(() => {
        load(false);
        return subscribeObserveRefresh(() => load(true));
    }, [load]);

    const groups = useMemo(() => (groupByConv ? groupRequestsByConversation(items) : null), [groupByConv, items]);

    const pageStart = total === 0 ? 0 : offset + 1;
    const pageEnd = Math.min(offset + items.length, total);

    return (
        <section>
            <PageHeader
                title="Requests"
                description="One row per agent turn. Token out may be ~estimated when hooks did not report usage."
            />

            <div className="requests-toolbar">
                <label className="requests-toolbar-search">
                    <span className="obs-sub text-xs">Search</span>
                    <input
                        type="search"
                        className="obs-search"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setOffset(0);
                        }}
                        placeholder="Substring in user query…"
                    />
                </label>
                <label className="requests-toolbar-check">
                    <input
                        type="checkbox"
                        checked={groupByConv}
                        onChange={(e) => setGroupByConv(e.target.checked)}
                    />
                    Group by conversation
                </label>
                <label className="requests-toolbar-check">
                    <input
                        type="checkbox"
                        checked={failuresOnly}
                        onChange={(e) => {
                            setFailuresOnly(e.target.checked);
                            setOffset(0);
                        }}
                    />
                    Failures only
                </label>
            </div>

            {loading && items.length === 0 && <LoadingState label="Loading requests…" />}
            {error && (
                <ErrorBanner
                    message={`Could not load requests: ${error}. Run ./scripts/dev-observe.sh or observe on :8792.`}
                />
            )}
            {!loading && !error && items.length === 0 && (
                <EmptyState
                    title="No requests yet"
                    hint="Turns come from Cursor agent-transcripts ingest. Chat in Cursor, then Status → Run ingest now, or wait for poll."
                />
            )}

            {items.length > 0 && (
                <>
                    <p className="obs-sub m-0 mb-2">
                        Showing {pageStart}–{pageEnd} of {total}
                    </p>
                    {groupByConv && groups ? (
                        <div className="request-groups">
                            {groups.map((g) => (
                                <details key={g.conversationId} className="request-group" open>
                                    <summary>
                                        <span className="obs-mono">{g.conversationId.slice(0, 16)}…</span>
                                        <span className="obs-sub">
                                            {g.items.length} turn(s) · latest {formatRelativeWhen(g.latestStartedAt)}
                                        </span>
                                    </summary>
                                    <div className="obs-table-wrap mt-2">
                                        <table className="obs-table obs-table--requests">
                                            <RequestTableHead />
                                            <tbody>
                                                {g.items.map((row) => (
                                                    <RequestRow key={row.id} row={row} />
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </details>
                            ))}
                        </div>
                    ) : (
                        <div className="obs-table-wrap obs-table-wrap--sticky">
                            <table className="obs-table obs-table--requests">
                                <RequestTableHead showConversation />
                                <tbody>
                                    {items.map((row) => (
                                        <RequestRow key={row.id} row={row} showConversation />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="flex gap-2 mt-4">
                        <button
                            type="button"
                            className="obs-btn obs-btn--ghost"
                            disabled={offset <= 0 || loading}
                            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                        >
                            Previous
                        </button>
                        <button
                            type="button"
                            className="obs-btn obs-btn--ghost"
                            disabled={offset + PAGE_SIZE >= total || loading}
                            onClick={() => setOffset((o) => o + PAGE_SIZE)}
                        >
                            Next
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}
