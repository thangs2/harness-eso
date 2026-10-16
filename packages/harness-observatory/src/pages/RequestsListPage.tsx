import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRequests } from '@/shared/api/client';
import type { RequestListItem } from '@/shared/api/types';
import { groupRequestsByConversation } from '@/shared/requests/groupByConversation';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { Badge } from '@/ui/Badge';
import { EmptyState, ErrorBanner, LoadingState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import { IdeBadge } from '@/ui/IdeBadge';
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
                {showConversation ? <th>IDE</th> : null}
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
    if (pass === 0 && fail === 0) return <span className="obs-sub">—</span>;
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
    const ideClass = row.ide ? `obs-row--${row.ide}` : '';

    return (
        <tr className={`${fail ? 'obs-row--fail' : ''} ${ideClass}`.trim() || undefined}>
            <td className="obs-sub tabular-nums obs-col-num">{row.boundaryIndex}</td>
            <td className="obs-sub whitespace-nowrap obs-col-when" title={formatWhenFull(row.startedAt)}>
                {formatRelativeWhen(row.startedAt)}
            </td>
            {showConversation ? (
                <td className="whitespace-nowrap">
                    <IdeBadge ide={row.ide} size="sm" />
                </td>
            ) : null}
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
                <span className="truncate block max-w-[8.5rem]">{row.modelId?.split('/').pop() ?? '—'}</span>
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
    const [ideFilter, setIdeFilter] = useState<string>('all');

    const inFlightRef = useRef(false);
    const load = useCallback((background = false) => {
        if (!background) setLoading(true);
        if (inFlightRef.current && background) return;
        inFlightRef.current = true;
        fetchRequests({
            limit: PAGE_SIZE,
            offset,
            q: query.trim() || undefined,
            hasFailures: failuresOnly || undefined,
            ide: ideFilter === 'all' ? undefined : ideFilter,
        })
            .then((res) => {
                setItems(res.items);
                setTotal(res.page.total);
                setError(null);
            })
            .catch((e: Error) => {
                if (!background) setError(e.message);
            })
            .finally(() => {
                inFlightRef.current = false;
                setLoading(false);
            });
    }, [offset, query, failuresOnly, ideFilter]);

    useEffect(() => {
        load(false);
        return subscribeObserveRefresh((reason) => {
            if (reason === 'live') return;
            load(true);
        });
    }, [load]);

    const groups = useMemo(() => (groupByConv ? groupRequestsByConversation(items) : null), [groupByConv, items]);

    const pageStart = total === 0 ? 0 : offset + 1;
    const pageEnd = Math.min(offset + items.length, total);

    return (
        <section className="requests-page">
            <PageHeader
                title="Requests"
                description="One row per agent turn. Token out may be ~estimated when hooks did not report usage."
            />

            <div className="requests-toolbar flex flex-wrap items-center gap-3">
                <label className="requests-toolbar-search flex-1 min-w-[200px]">
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

                {/* IDE Filter segment */}
                <div className="flex flex-col gap-1">
                    <span className="obs-sub text-xs">IDE Filter</span>
                    <div className="flex items-center gap-1 bg-surface-card p-1 rounded-lg border border-surface-border text-xs">
                        <button
                            type="button"
                            className={`px-2.5 py-1 rounded transition-colors ${
                                ideFilter === 'all'
                                    ? 'bg-surface-raised font-semibold text-slate-100 shadow-sm border border-surface-border'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                            onClick={() => {
                                setIdeFilter('all');
                                setOffset(0);
                            }}
                        >
                            All IDEs
                        </button>
                        <button
                            type="button"
                            className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 ${
                                ideFilter === 'cursor'
                                    ? 'bg-cyan-950/60 font-semibold text-cyan-200 border border-cyan-500/40 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                            onClick={() => {
                                setIdeFilter('cursor');
                                setOffset(0);
                            }}
                        >
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                            Cursor
                        </button>
                        <button
                            type="button"
                            className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 ${
                                ideFilter === 'antigravity'
                                    ? 'bg-purple-950/60 font-semibold text-purple-200 border border-purple-500/40 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                            onClick={() => {
                                setIdeFilter('antigravity');
                                setOffset(0);
                            }}
                        >
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                            Antigravity
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-3 pt-4">
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
            </div>

            {loading && items.length === 0 && <LoadingState label="Loading requests…" />}
            {error && (
                <ErrorBanner
                    message={`Could not load requests: ${error}. Run ./scripts/dev-observe.sh or check Observatory service.`}
                />
            )}
            {!loading && !error && items.length === 0 && (
                <EmptyState
                    title="No requests found yet"
                    hint="Waiting for agent activity. Start a session in your IDE (Cursor / Antigravity) to begin recording requests."
                />
            )}

            {items.length > 0 && (
                <>
                    <p className="obs-sub m-0 mb-2">
                        Showing {pageStart}–{pageEnd} of {total}
                    </p>
                    {groupByConv && groups ? (
                        <div className="request-groups space-y-3">
                            {groups.map((g) => (
                                <details
                                    key={g.conversationId}
                                    className={`request-group request-group--${g.ide || 'unknown'}`}
                                    open
                                >
                                    <summary className={`request-group-summary request-group-summary--${g.ide || 'unknown'} flex items-center justify-between gap-3 py-3 px-4 select-none cursor-pointer transition-all`}>
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="request-group-chevron inline-flex items-center justify-center transition-transform duration-200">
                                                <svg className="w-3.5 h-3.5 transition-transform duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                                                </svg>
                                            </span>
                                            <IdeBadge ide={g.ide} />
                                            <span className="obs-mono font-semibold" title={g.conversationId}>
                                                {g.conversationId.slice(0, 16)}…
                                            </span>
                                            <span className="request-group-turns-badge text-[11px] px-2.5 py-0.5 rounded-full font-medium">
                                                {g.items.length} turn(s)
                                            </span>
                                        </div>
                                        <span className="request-group-time text-xs tabular-nums font-medium">
                                            latest {formatRelativeWhen(g.latestStartedAt)}
                                        </span>
                                    </summary>
                                    <div className="obs-table-wrap">
                                        <table className={`obs-table obs-table--requests obs-table--ide-${g.ide || 'unknown'}`}>
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
