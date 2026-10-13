import type { RequestDetailResponse } from '@/shared/api/types';
import { Badge } from '@/ui/Badge';
import { Panel } from '@/ui/Panel';

type TokenSummary = {
    input?: number | null;
    output?: number | null;
    cacheRead?: number | null;
    source?: string;
    estimated?: boolean;
    /** Set when the transcript carried no usage at all — see tokenSummaryForRequest. */
    inputUnavailable?: string | null;
};

type McpStats = {
    flashBrain?: number;
    flashExecutor?: number;
    proCount?: number;
    jevCount?: number;
};

type RequestMetrics = {
    callCount?: number;
    toolCount?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    modelId?: string | null;
    mcpCallStats?: McpStats | null;
};

type StopRow = {
    harness?: string;
    modelId?: string;
    status?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheRead?: number | null;
};

function fmt(n: number | null | undefined): string | null {
    if (n == null || !Number.isFinite(n)) return null;
    return n.toLocaleString();
}

/** A measurement tile: label, value, and where the number came from. */
function StatTile({
    label,
    value,
    hint,
    tone = 'plain',
}: {
    label: string;
    value: string | null;
    hint?: string;
    tone?: 'plain' | 'unknown' | 'est';
}) {
    return (
        <div className="tokens-tile" data-tone={value == null ? 'unknown' : tone}>
            <span className="tokens-tile-label">{label}</span>
            <span className="tokens-tile-value">{value ?? '—'}</span>
            {hint ? <span className="tokens-tile-hint">{hint}</span> : null}
        </div>
    );
}

export function TokensBlock({ detail }: { detail: RequestDetailResponse }) {
    const tokenSummary = detail.tokenSummary as TokenSummary | undefined;
    const metrics = detail.requestMetrics as RequestMetrics | undefined;
    const mcp =
        (metrics?.mcpCallStats as McpStats | null | undefined) ??
        (detail.mcpCallStats as McpStats | null | undefined);
    const stops = ((detail.stops as StopRow[] | undefined) ?? []).filter(Boolean);

    const input =
        metrics?.inputTokens ?? tokenSummary?.input ?? stops[0]?.inputTokens ?? null;
    const output =
        metrics?.outputTokens ?? tokenSummary?.output ?? stops[0]?.outputTokens ?? null;
    const cacheRead =
        metrics?.cacheReadTokens ?? tokenSummary?.cacheRead ?? stops[0]?.cacheRead ?? null;

    const estimated = tokenSummary?.estimated === true;
    const inputUnknown = input == null;
    const hasAny = input != null || output != null || cacheRead != null;
    const hasMcp = Boolean(
        mcp && (mcp.flashBrain || mcp.flashExecutor || mcp.proCount || mcp.jevCount),
    );

    const mcpTiles: Array<{ label: string; value: number }> = mcp
        ? [
              { label: 'flash', value: mcp.flashBrain ?? 0 },
              { label: 'executor', value: mcp.flashExecutor ?? 0 },
              { label: 'pro', value: mcp.proCount ?? 0 },
              { label: 'jev', value: mcp.jevCount ?? 0 },
          ]
        : [];

    /*
     * A proportion bar is only honest when the parts share a denominator. Input and output
     * are disjoint token classes on the wire but they do NOT come from the same measurement
     * here (input unknown, output estimated), so the bar renders only when both were actually
     * reported. Drawing it from one number would imply a ratio nobody measured.
     */
    const hasBoth = input != null && output != null;
    const total = hasBoth ? (input ?? 0) + (output ?? 0) : 0;
    const inputPct = hasBoth && total > 0 ? ((input ?? 0) / total) * 100 : 0;

    // Per-producer split. Only worth a table when a stop row carries usage, and only
    // interesting when the totals above are a sum of more than one measurement.
    const stopRows = stops.filter(
        (s) => s.inputTokens != null || s.outputTokens != null || s.cacheRead != null,
    );

    const empty = !hasAny && !hasMcp && !metrics?.callCount;

    return (
        <Panel
            className="tokens-card"
            data-testid="tokens-block"
            data-estimated={estimated}
            title="Tokens &amp; cost"
            lede="What this turn spent, and how it was measured."
            badges={
                <>
                    {tokenSummary?.source ? <Badge tone="neutral">{tokenSummary.source}</Badge> : null}
                    {estimated ? <Badge tone="warn">estimated</Badge> : null}
                    {!estimated && hasAny ? <Badge tone="ok">reported</Badge> : null}
                </>
            }
            footer={
                <>
                    {metrics?.modelId ? (
                        <span className="obs-card-flag">
                            model <b className="obs-mono">{metrics.modelId}</b>
                        </span>
                    ) : null}
                    {metrics?.callCount != null ? (
                        <span className="obs-card-flag">
                            LLM calls <b className="tabular-nums">{metrics.callCount}</b>
                        </span>
                    ) : null}
                    {metrics?.toolCount != null ? (
                        <span className="obs-card-flag">
                            tool uses <b className="tabular-nums">{metrics.toolCount}</b>
                        </span>
                    ) : null}
                </>
            }
        >
            {empty ? (
                <p className="obs-sub m-0">
                    No token totals yet — a hook <code>stop</code> payload or a transcript estimate.
                </p>
            ) : (
                <>
                    <div className="tokens-tiles">
                        <StatTile
                            label="Input"
                            value={fmt(input)}
                            hint={inputUnknown ? 'not reported' : undefined}
                        />
                        <StatTile
                            label="Output"
                            value={fmt(output)}
                            tone={estimated ? 'est' : 'plain'}
                            hint={output != null && estimated ? 'chars ÷ 4' : undefined}
                        />
                        <StatTile
                            label="Cache read"
                            value={fmt(cacheRead)}
                            hint={cacheRead == null ? 'not reported' : undefined}
                        />
                    </div>

                    {hasBoth ? (
                        <div className="tokens-ratio">
                            <div className="tokens-ratio-bar" aria-hidden="true">
                                <span className="tokens-ratio-in" style={{ width: `${inputPct}%` }} />
                            </div>
                            {/* Labels only — the tiles directly above already carry the values,
                                and repeating them here made the card state each number twice. */}
                            <div className="tokens-ratio-legend">
                                <span>
                                    <i className="tokens-swatch tokens-swatch--in" />
                                    input {inputPct.toFixed(0)}%
                                </span>
                                <span>
                                    <i className="tokens-swatch tokens-swatch--out" />
                                    output {(100 - inputPct).toFixed(0)}%
                                </span>
                            </div>
                        </div>
                    ) : null}

                    {stopRows.length > 0 ? (
                        <div className="tokens-breakdown">
                            <h4 className="tokens-breakdown-title">per harness · hook stop</h4>
                            <table>
                                <thead>
                                    <tr>
                                        <th>harness</th>
                                        <th>status</th>
                                        <th style={{ textAlign: 'right' }}>in</th>
                                        <th style={{ textAlign: 'right' }}>out</th>
                                        <th style={{ textAlign: 'right' }}>cache</th>
                                        <th>model</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stopRows.slice(0, 6).map((s, i) => (
                                        <tr key={`${s.harness ?? 'h'}-${i}`}>
                                            <td>{s.harness ?? '—'}</td>
                                            <td>{s.status ?? '—'}</td>
                                            <td style={{ textAlign: 'right' }}>{fmt(s.inputTokens) ?? '—'}</td>
                                            <td style={{ textAlign: 'right' }}>{fmt(s.outputTokens) ?? '—'}</td>
                                            <td style={{ textAlign: 'right' }}>{fmt(s.cacheRead) ?? '—'}</td>
                                            <td className="obs-mono">{s.modelId ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}

                    {hasMcp ? (
                        <div className="tokens-mcp">
                            {mcpTiles.map((t) => (
                                <div key={t.label} className="tokens-mcp-tile" data-zero={t.value === 0}>
                                    <span className="tokens-mcp-value">{t.value}</span>
                                    <span className="tokens-mcp-label">{t.label}</span>
                                </div>
                            ))}
                            <span className="tokens-mcp-note">MCP calls</span>
                        </div>
                    ) : null}
                </>
            )}

            {inputUnknown && !empty ? (
                <p className="tokens-note">
                    <strong>Input tokens unknown.</strong> Only a hook <code>stop</code> payload
                    reports them; a transcript does not carry usage, and the model&apos;s input is
                    the whole context (system prompt + attached rules + files + history), so it
                    cannot be reconstructed from the prompt text.
                    {estimated ? ' Output is estimated from the assistant text (chars ÷ 4).' : ''}
                </p>
            ) : null}
        </Panel>
    );
}
