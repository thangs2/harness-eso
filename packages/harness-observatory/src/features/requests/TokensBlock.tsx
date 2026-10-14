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
    /** Smart-routed calls whose tier the server decides at call time — not guessed into brain/pro. */
    smartRouteCount?: number;
    /** Jev decisions — HTTP to the decision facade, not MCP calls. */
    jevCount?: number;
    brainPromptTokens?: number | null;
    brainCompletionTokens?: number | null;
    brainCacheHitTokens?: number | null;
    brainReasoningTokens?: number | null;
    /** How many MCP calls reported usage; fewer than the call count means a partial report. */
    brainUsageCalls?: number;
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
    /**
     * MCP **tool** calls (Jira, search, browser…) — a different quantity from the model calls in
     * `mcpCallStats`. Both travel over MCP and nothing else is shared: different counts, different
     * costs. Kept separate because labelling the model figure "MCP calls" read as the tool count.
     */
    mcpToolCalls?: number;
    mcpToolKinds?: number;
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

    /*
     * Brain is the model side of the turn: the Pro and flash-brain tiers the Dispatcher delegates
     * to. The executor tier is deliberately excluded — it is thinking-off tooling, not reasoning.
     *
     * `brainUsageCalls` is the honesty hinge. The Dispatcher's totals come from the `stop` hook and
     * are always its own usage; the Brain's come from the MCP server's ledger, which may be missing
     * (server not yet updated, or the ledger not shared with this deployment). When Brain calls
     * happened but none reported usage, the card must say so — otherwise a reader adds up the tiles
     * and concludes the turn was cheap when most of its cost is simply unmeasured.
     */
    const brainCalls = (mcp?.flashBrain ?? 0) + (mcp?.proCount ?? 0);
    const brainUsageCalls = mcp?.brainUsageCalls ?? 0;
    const brainIn = mcp?.brainPromptTokens ?? null;
    const brainOut = mcp?.brainCompletionTokens ?? null;
    const brainCache = mcp?.brainCacheHitTokens ?? null;
    const brainTokensUnknown = brainCalls > 0 && brainUsageCalls === 0;
    const brainTokensPartial = brainUsageCalls > 0 && brainUsageCalls < brainCalls;

    /*
     * Two different quantities share the MCP transport and must not share a label:
     *
     *   - `modelCalls` — calls the agent made *to a model* through an MCP server (DeepSeek Brain,
     *     executor, Pro). This is what carries token cost, and it is what `mcpCallStats` counts.
     *   - `mcpToolCalls` — calls to an MCP *tool* (Jira, search, browser). No tokens of their own.
     *
     * The card previously showed only the first under the label "MCP calls", so a turn with five
     * Jira/search calls displayed no MCP activity at all.
     */
    const modelCalls =
        (mcp?.flashBrain ?? 0) +
        (mcp?.flashExecutor ?? 0) +
        (mcp?.proCount ?? 0) +
        (mcp?.smartRouteCount ?? 0);
    const mcpToolCalls = metrics?.mcpToolCalls ?? 0;
    const mcpToolKinds = metrics?.mcpToolKinds ?? 0;

    const hasModelCalls = modelCalls > 0;

    const mcpTiles: Array<{ label: string; value: number }> = mcp
        ? [
              { label: 'flash brain', value: mcp.flashBrain ?? 0 },
              { label: 'executor', value: mcp.flashExecutor ?? 0 },
              { label: 'pro', value: mcp.proCount ?? 0 },
              { label: 'smart', value: mcp.smartRouteCount ?? 0 },
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

    const empty = !hasAny && !hasModelCalls && !metrics?.callCount && mcpToolCalls === 0;

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
                    {!estimated && hasAny ? <Badge tone="ok">dispatcher reported</Badge> : null}
                    {brainTokensUnknown ? (
                        <Badge tone="warn">brain tokens not reported</Badge>
                    ) : null}
                    {brainTokensPartial ? <Badge tone="warn">brain tokens partial</Badge> : null}
                    {brainUsageCalls > 0 && !brainTokensPartial ? (
                        <Badge tone="ok">brain tokens reported</Badge>
                    ) : null}
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
                    {/* The tiles above are one measurement, not the whole turn: `stop` reports the
                        Dispatcher. The Brain's own spend is a separate measurement below. */}
                    <h4 className="tokens-breakdown-title">dispatcher · hook stop</h4>
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

                    {/*
                     * MCP *tool* calls — a count of calls, not of tokens. Rendered before the model
                     * block so the two read as distinct facts rather than one ambiguous "MCP" figure.
                     */}
                    {mcpToolCalls > 0 ? (
                        <div className="tokens-mcp" data-testid="mcp-tool-calls">
                            <div className="tokens-mcp-tile">
                                <span className="tokens-mcp-value">{mcpToolCalls}</span>
                                <span className="tokens-mcp-label">tools</span>
                            </div>
                            <span className="tokens-mcp-note">
                                MCP tool calls{mcpToolKinds > 1 ? ` · ${mcpToolKinds} kinds` : ''}
                            </span>
                        </div>
                    ) : null}

                    {hasModelCalls ? (
                        <div className="tokens-mcp" data-testid="mcp-model-calls">
                            {mcpTiles.map((t) => (
                                <div key={t.label} className="tokens-mcp-tile" data-zero={t.value === 0}>
                                    <span className="tokens-mcp-value">{t.value}</span>
                                    <span className="tokens-mcp-label">{t.label}</span>
                                </div>
                            ))}
                            <span className="tokens-mcp-note">
                                model calls over MCP · {modelCalls} total
                            </span>
                        </div>
                    ) : null}

                    {/*
                     * Jev sits in the same card because it is a per-turn model-call count, but it is
                     * not an MCP call — Jev is invoked over HTTP by the decision facade. Shown as its
                     * own line rather than as a fifth tile so neither the "model calls over MCP" nor
                     * the "MCP tool calls" figure is diluted with something that is neither.
                     */}
                    {(mcp?.jevCount ?? 0) > 0 ? (
                        <p className="tokens-note">
                            <strong>Jev decisions {mcp?.jevCount}.</strong> HTTP to the decision
                            facade, not an MCP call.
                        </p>
                    ) : null}

                    {brainCalls > 0 ? (
                        <div className="tokens-breakdown" data-testid="brain-tokens">
                            <h4 className="tokens-breakdown-title">brain · MCP server</h4>
                            <div className="tokens-tiles">
                                <StatTile
                                    label="Brain input"
                                    value={fmt(brainIn)}
                                    hint={brainIn == null ? 'not reported' : undefined}
                                />
                                <StatTile
                                    label="Brain output"
                                    value={fmt(brainOut)}
                                    hint={brainOut == null ? 'not reported' : undefined}
                                />
                                <StatTile
                                    label="Brain cache read"
                                    value={fmt(brainCache)}
                                    hint={brainCache == null ? 'not reported' : undefined}
                                />
                            </div>
                            <p className="tokens-note">
                                {brainTokensUnknown ? (
                                    <>
                                        <strong>Brain tokens not reported.</strong> This turn requested{' '}
                                        {brainCalls} Brain call{brainCalls === 1 ? '' : 's'}, but the
                                        MCP server reported no usage for{' '}
                                        {brainCalls === 1 ? 'it' : 'any of them'} — so the Dispatcher
                                        figures above are not the cost of the turn.
                                        {/*
                                         * "requested", not "made": the transcript records the agent's
                                         * tool call, and Cursor writes no tool result, so a call that
                                         * was dispatched and then cancelled or timed out out is
                                         * indistinguishable here from one that ran. Seen on x79: a
                                         * `[BRAIN FLASH]` call was dispatched, never reached the
                                         * server (no log, no ledger, no hook event), and this counter
                                         * still read 1.
                                         */}
                                    </>
                                ) : brainTokensPartial ? (
                                    <>
                                        <strong>Partial.</strong> {brainUsageCalls} of {brainCalls}{' '}
                                        Brain calls reported usage; the rest did not, so these sums
                                        understate the turn.
                                    </>
                                ) : (
                                    <>
                                        Reported by the MCP server for {brainUsageCalls} Brain call
                                        {brainUsageCalls === 1 ? '' : 's'} ({fmt(brainIn) ?? '—'} in,{' '}
                                        {fmt(brainOut) ?? '—'} out).
                                    </>
                                )}
                            </p>
                        </div>
                    ) : null}
                </>
            )}

            {inputUnknown && !empty ? (
                <p className="tokens-note">
                    <strong>Dispatcher input tokens unknown.</strong> Only a hook{' '}
                    <code>stop</code> payload reports them; a transcript does not carry usage, and the
                    model&apos;s input is the whole context (system prompt + attached rules + files +
                    history), so it cannot be reconstructed from the prompt text.
                    {estimated ? ' Output is estimated from the assistant text (chars ÷ 4).' : ''}
                </p>
            ) : null}
        </Panel>
    );
}
