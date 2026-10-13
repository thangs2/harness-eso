import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RequestDetailResponse } from '@/shared/api/types';
import { Panel } from '@/ui/Panel';

interface LlmRow {
    callIndex?: number;
    kind?: string;
    preview?: string;
    toolCount?: number;
}

interface EventRow {
    eventType?: string;
    tool?: string;
    path?: string;
    hookAt?: string;
    command?: string;
}

export function RequestTreeView({ detail, requestId }: { detail: RequestDetailResponse; requestId: string }) {
    const req = detail.request as Record<string, unknown> | undefined;
    const query = String(req?.userQuery ?? req?.user_query ?? requestId);
    const boundary = req?.boundaryIndex ?? req?.boundary_index;
    const llmCalls = (detail.llmCalls as LlmRow[]) ?? [];
    const events = (detail.events as EventRow[]) ?? [];
    const tools = (detail.tools as Array<{ tool: string; count: number }>) ?? [];
    const checks = detail.checks ?? [];
    const files = detail.files ?? [];

    return (
        <div className="request-tree">
            <Panel title="Request root">
                <p className="m-0 font-medium">{query.slice(0, 200)}</p>
                <p className="obs-mono obs-sub m-0 mt-1">
                    {requestId} · boundary {String(boundary ?? '—')}
                </p>
                <p className="m-0 mt-2">
                    <Link to={`/requests/${requestId}`}>Open full detail →</Link>
                </p>
            </Panel>

            <TreeBranch title={`LLM calls (${llmCalls.length})`} defaultOpen>
                {llmCalls.length === 0 ? (
                    <p className="obs-sub m-0 pl-4">No calls ingested.</p>
                ) : (
                    <ul className="tree-list">
                        {llmCalls.map((c, i) => (
                            <li key={i}>
                                <span className="tree-tag">{c.kind ?? 'call'}</span>
                                #{c.callIndex ?? i}
                                {c.toolCount != null ? ` · ${c.toolCount} tool(s)` : ''}
                                {c.preview ? ` — ${c.preview.slice(0, 72)}…` : ''}
                            </li>
                        ))}
                    </ul>
                )}
            </TreeBranch>

            <TreeBranch title={`Hook / route events (${events.length})`} defaultOpen>
                {detail.evidenceNote && <p className="obs-sub m-0 pl-4 mb-2">{detail.evidenceNote}</p>}
                {events.length === 0 ? (
                    <p className="obs-sub m-0 pl-4">No linked events.</p>
                ) : (
                    <ul className="tree-list">
                        {events.slice(0, 120).map((e, i) => (
                            <li key={i}>
                                <span className="tree-tag">{e.eventType ?? 'event'}</span>
                                {e.hookAt ? `${e.hookAt} · ` : ''}
                                {e.tool ?? ''}
                                {e.path ? ` · ${e.path}` : ''}
                                {e.command ? ` · ${String(e.command).slice(0, 48)}` : ''}
                            </li>
                        ))}
                    </ul>
                )}
            </TreeBranch>

            <TreeBranch title={`Tools (${tools.length})`}>
                <ul className="tree-list">
                    {tools.map((t) => (
                        <li key={t.tool}>{t.tool} × {t.count}</li>
                    ))}
                </ul>
            </TreeBranch>

            <TreeBranch title={`Checks (${checks.length})`}>
                <ul className="tree-list">
                    {checks.map((c) => (
                        <li key={c.checkId}>
                            {c.checkId} — <strong>{c.status}</strong>
                        </li>
                    ))}
                </ul>
            </TreeBranch>

            <TreeBranch title={`Files (${files.length})`}>
                <ul className="tree-list">
                    {files.slice(0, 40).map((f) => (
                        <li key={f.path} className="obs-mono">
                            {f.path} (r{f.reads} e{f.edits})
                        </li>
                    ))}
                </ul>
            </TreeBranch>
        </div>
    );
}

function TreeBranch({
    title,
    children,
    defaultOpen = false,
}: {
    title: string;
    children: ReactNode;
    defaultOpen?: boolean;
}) {
    return (
        <details className="tree-branch" open={defaultOpen}>
            <summary>{title}</summary>
            <div className="tree-branch-body">{children}</div>
        </details>
    );
}
