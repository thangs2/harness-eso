import { Link } from 'react-router-dom';
import type { RequestDetailResponse } from '@/shared/api/types';
import { Badge } from '@/ui/Badge';
import {
    formatDuration,
    formatRelativeWhen,
    formatWhenFull,
    requestStatusTone,
    sufficiencyTone,
    verdictTone,
} from '@/ui/statusTone';

function pickRequestField(req: Record<string, unknown> | undefined, ...keys: string[]) {
    if (!req) return undefined;
    for (const k of keys) {
        const v = req[k];
        if (v != null && v !== '') return v;
    }
    return undefined;
}

/** One `label value` fact in the identity strip. */
function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
    return (
        <span className="request-fact">
            <span className="request-fact-label">{label}</span>
            <span className="request-fact-value" title={title}>
                {value}
            </span>
        </span>
    );
}

export function RequestDetailHeader({ detail, id }: { detail: RequestDetailResponse; id: string }) {
    const req = detail.request as Record<string, unknown> | undefined;
    const metrics = detail.requestMetrics;

    const query =
        (pickRequestField(req, 'userQuery', 'user_query') as string | undefined) ?? id;
    const boundary = pickRequestField(req, 'boundaryIndex', 'boundary_index') as number | undefined;
    const status = String(pickRequestField(req, 'status') ?? 'unknown');
    const stopStatus = pickRequestField(req, 'stopStatus', 'stop_status') as string | undefined;
    const started = pickRequestField(req, 'startedAt', 'started_at') as string | undefined;
    const ended = pickRequestField(req, 'endedAt', 'ended_at') as string | undefined;
    const harness = pickRequestField(req, 'harness') as string | undefined;
    const conversationId = pickRequestField(req, 'conversationId', 'conversation_id') as string | undefined;
    const generationId = pickRequestField(req, 'generationId', 'generation_id') as string | undefined;

    const sufficiency = detail.eso?.sufficiency ?? (detail.evidence?.level as string | undefined);
    const enforced =
        detail.decisionFlow?.evidenceSufficiency?.enforcedVerdict ??
        (detail.evidence?.enforcedVerdict as string | undefined);

    const duration = formatDuration(started ?? null, ended ?? null);
    const whenFull = formatWhenFull(started);

    /*
     * Identity + timing ONLY. This strip used to repeat Token in/out, Cache read, Calls,
     * Tools and Model — every one of which the Tokens & cost card already reports from the
     * same fields, so the two could disagree and the page said the same thing twice. Cost
     * and volume live in their card; what stays here is what identifies the turn.
     *
     * `ended` is not a fact of its own: `started` plus `duration` determines it, and printing
     * both bounds as "9h ago · 9h ago" read as a duplicated column rather than as information.
     */
    const facts: Array<{ label: string; value: string; title?: string }> = [];
    if (started) {
        facts.push({ label: 'started', value: formatRelativeWhen(started), title: whenFull });
    }
    if (duration) facts.push({ label: 'duration', value: duration, title: ended ? formatWhenFull(ended) : undefined });
    if (metrics?.modelId) facts.push({ label: 'model', value: metrics.modelId });
    if (harness) facts.push({ label: 'harness', value: harness });

    return (
        <header className="request-detail-hero">
            {/* Golden-standard order: the query is the page heading, and identity
                (conversation · boundary · generation) is a locator in the top bar. */}
            <nav className="request-detail-nav mb-3">
                <Link to="/requests" className="obs-crumb">← Requests</Link>
                <span className="obs-crumb-sep" aria-hidden="true">/</span>
                <span className="obs-crumb-current obs-mono">
                    {conversationId ? `${conversationId} ` : ''}
                    {boundary != null ? `#${boundary}` : ''}
                    {generationId ? ` · gen ${generationId}` : ''}
                </span>
                <div className="request-detail-actions">
                    <Link to={`/tree/${id}`} className="obs-pill">Tree</Link>
                    <Link to={`/graph?requestId=${encodeURIComponent(id)}`} className="obs-pill">
                        Graph
                    </Link>
                    <Link to={`/decisions?requestId=${encodeURIComponent(id)}`} className="obs-pill">
                        Decisions
                    </Link>
                </div>
            </nav>

            <div className="request-detail-title-row">
                <h1 className="request-detail-title">{query.slice(0, 200)}</h1>
                <div className="request-detail-badges">
                    <Badge tone={requestStatusTone(status)} dot>{status}</Badge>
                    {stopStatus && stopStatus !== status ? (
                        <Badge tone={requestStatusTone(stopStatus)} dot>stop: {stopStatus}</Badge>
                    ) : null}
                    {sufficiency ? (
                        <Badge tone={sufficiencyTone(String(sufficiency))}>ESO {String(sufficiency)}</Badge>
                    ) : null}
                    {enforced ? <Badge tone={verdictTone(String(enforced))}>{String(enforced)}</Badge> : null}
                    {metrics?.hasFailures ? <Badge tone="danger">checks failed</Badge> : null}
                </div>
            </div>

            {facts.length > 0 ? (
                <div className="request-facts">
                    {facts.map((f) => (
                        <Fact key={f.label} label={f.label} value={f.value} title={f.title} />
                    ))}
                </div>
            ) : null}
        </header>
    );
}
