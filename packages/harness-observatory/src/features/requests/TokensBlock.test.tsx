import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokensBlock } from './TokensBlock';
import type { RequestDetailResponse } from '@/shared/api/types';

/** Minimal detail shape — TokensBlock only reads tokenSummary / requestMetrics / stops. */
function detail(over: Partial<RequestDetailResponse>): RequestDetailResponse {
    return { request: {}, ...over } as RequestDetailResponse;
}

describe('TokensBlock', () => {
    it('shows an unmeasured input as unknown, never as a number', () => {
        // The old estimator reported the prompt's own length ÷ 4 as "input", which rendered as
        // a real measurement (9 next to 628 out). A transcript carries no usage at all.
        render(
            <TokensBlock
                detail={detail({
                    tokenSummary: {
                        input: null,
                        output: 628,
                        cacheRead: null,
                        source: 'transcript-est',
                        estimated: true,
                        inputUnavailable: 'no_token_usage_in_transcript',
                    },
                    requestMetrics: { callCount: 21, toolCount: 46 },
                })}
            />,
        );
        const card = screen.getByTestId('tokens-block');
        expect(card.textContent).toContain('not reported');
        expect(card.querySelector('.tokens-tile[data-tone="unknown"]')?.textContent).toContain('—');
        // The dash must not be a digit.
        expect(card.querySelector('.tokens-tile[data-tone="unknown"]')?.textContent).not.toMatch(/\d/);
    });

    it('omits the ratio bar unless input and output were both reported', () => {
        const { container: partial } = render(
            <TokensBlock
                detail={detail({
                    tokenSummary: { input: null, output: 628, source: 'transcript-est', estimated: true },
                })}
            />,
        );
        // One known part is not a ratio.
        expect(partial.querySelector('.tokens-ratio')).toBeNull();

        const { container: both } = render(
            <TokensBlock
                detail={detail({
                    tokenSummary: { input: 1200, output: 800, source: 'stop (cursor)' },
                })}
            />,
        );
        expect(both.querySelector('.tokens-ratio')).toBeTruthy();
        expect(both.querySelector('.tokens-ratio-in')?.getAttribute('style')).toContain('60%');
    });

    it('marks an estimated output as estimated and a reported one as reported', () => {
        const { container: est } = render(
            <TokensBlock
                detail={detail({ tokenSummary: { output: 628, source: 'transcript-est', estimated: true } })}
            />,
        );
        // The badge is upcased by CSS, so compare case-insensitively against the DOM text.
        expect(est.textContent?.toLowerCase()).toContain('estimated');
        expect(est.querySelector('.tokens-tile[data-tone="est"]')).toBeTruthy();

        const { container: real } = render(
            <TokensBlock
                detail={detail({
                    tokenSummary: { input: 10, output: 20, source: 'stop (cursor)' },
                    requestMetrics: { inputTokens: 10, outputTokens: 20 },
                })}
            />,
        );
        expect(real.textContent?.toLowerCase()).toContain('reported');
        expect(real.textContent?.toLowerCase()).not.toContain('estimated');
        expect(real.querySelector('.tokens-tile[data-tone="est"]')).toBeNull();
    });

    it('reports a genuinely empty turn instead of rendering a zeroed card', () => {
        render(<TokensBlock detail={detail({})} />);
        expect(screen.getByTestId('tokens-block').textContent).toContain('No token totals yet');
    });

    describe('brain token honesty', () => {
        /*
         * A Cursor turn's cost is mostly spent in MCP model calls. When the MCP server reports no
         * usage, the card must say so: a reader who only sees the Dispatcher's tiles would conclude
         * the turn was cheap when most of its cost is unmeasured.
         */
        it('states that brain tokens are unreported rather than implying the totals are complete', () => {
            const { container } = render(
                <TokensBlock
                    detail={detail({
                        tokenSummary: { input: 900, output: 120, source: 'stop (cursor)' },
                        requestMetrics: {
                            inputTokens: 900,
                            outputTokens: 120,
                            mcpCallStats: { flashBrain: 3, proCount: 1, brainUsageCalls: 0 },
                        },
                    })}
                />,
            );
            const brain = container.querySelector('[data-testid="brain-tokens"]');
            expect(brain).toBeTruthy();
            expect(brain?.textContent).toContain('Brain tokens not reported');
            // "requested", not "made": the transcript records the tool call, and Cursor writes no
            // tool result, so a dispatched-but-cancelled call is indistinguishable from one that ran.
            expect(brain?.textContent).toContain('requested 4 Brain calls');
            expect(brain?.textContent).toContain('not the cost of the turn');
            expect(container.textContent?.toLowerCase()).toContain('not reported');
        });

        it('shows the reported sums and flags a partial report', () => {
            const { container: full } = render(
                <TokensBlock
                    detail={detail({
                        requestMetrics: {
                            mcpCallStats: {
                                flashBrain: 2,
                                brainPromptTokens: 4242,
                                brainCompletionTokens: 777,
                                brainCacheHitTokens: 4000,
                                brainUsageCalls: 2,
                            },
                        },
                    })}
                />,
            );
            expect(full.querySelector('[data-testid="brain-tokens"]')?.textContent).toContain('4,242');
            expect(full.textContent?.toLowerCase()).toContain('brain tokens reported');

            const { container: partial } = render(
                <TokensBlock
                    detail={detail({
                        requestMetrics: {
                            mcpCallStats: {
                                flashBrain: 5,
                                brainPromptTokens: 100,
                                brainCompletionTokens: 10,
                                brainUsageCalls: 2,
                            },
                        },
                    })}
                />,
            );
            expect(partial.querySelector('[data-testid="brain-tokens"]')?.textContent).toContain('2 of 5');
            expect(partial.textContent?.toLowerCase()).toContain('partial');
        });

        it('keeps the executor out of the brain totals and counts Jev as decisions', () => {
            // Executor work is thinking-off tooling, not reasoning, so it must not inflate Brain.
            const { container } = render(
                <TokensBlock
                    detail={detail({
                        requestMetrics: {
                            mcpCallStats: {
                                flashExecutor: 7,
                                smartRouteCount: 3,
                                jevCount: 2,
                                brainUsageCalls: 0,
                            },
                        },
                    })}
                />,
            );
            expect(container.querySelector('[data-testid="brain-tokens"]')).toBeNull();
            const mcp = container.querySelector('[data-testid="mcp-model-calls"]');
            expect(mcp?.textContent).toContain('executor');
            expect(mcp?.textContent).toContain('smart');
            expect(container.textContent).toContain('Jev decisions 2');
            expect(container.textContent).toContain('not an MCP call');
        });

        it('separates MCP tool calls from model calls over MCP', () => {
            /*
             * Two different quantities share the MCP transport and nothing else. The card used to
             * label the model figure "MCP calls", so a turn that made five Jira/search calls showed no
             * MCP activity at all — and a reader would take that label for the tool count.
             */
            const { container } = render(
                <TokensBlock
                    detail={detail({
                        requestMetrics: {
                            callCount: 4,
                            toolCount: 10,
                            // Model calls through MCP: one brain call, no token report.
                            mcpCallStats: { flashBrain: 1, brainUsageCalls: 0 },
                            // Tool calls through MCP, a different thing entirely.
                            mcpToolCalls: 5,
                            mcpToolKinds: 3,
                        },
                    })}
                />,
            );

            const toolBlock = container.querySelector('[data-testid="mcp-tool-calls"]');
            expect(toolBlock?.textContent).toContain('5');
            expect(toolBlock?.textContent).toContain('MCP tool calls');
            expect(toolBlock?.textContent).toContain('3 kinds');

            const modelBlock = container.querySelector('[data-testid="mcp-model-calls"]');
            expect(modelBlock?.textContent).toContain('flash brain');
            expect(modelBlock?.textContent).toContain('model calls over MCP');

            // The two figures must not be conflated anywhere in the card.
            expect(toolBlock?.textContent).not.toContain('model');
            expect(modelBlock?.textContent).not.toContain('5');
        });

        it('shows MCP tool calls even when the turn made no model calls', () => {
            // The exact case that was invisible before: a Jira/search turn with no DeepSeek involvement.
            const { container } = render(
                <TokensBlock
                    detail={detail({
                        tokenSummary: { input: 140316, output: 2582, source: 'request' },
                        requestMetrics: { callCount: 4, toolCount: 10, mcpToolCalls: 5, mcpToolKinds: 3 },
                    })}
                />,
            );
            expect(container.querySelector('[data-testid="mcp-tool-calls"]')?.textContent).toContain('MCP tool calls');
            expect(container.querySelector('[data-testid="mcp-model-calls"]')).toBeNull();
            // And the card is not treated as empty just because no model call happened.
            expect(container.textContent).not.toContain('No token totals yet');
        });

        it('omits the MCP tool line for a turn that made no MCP tool call', () => {
            const { container } = render(
                <TokensBlock detail={detail({ requestMetrics: { callCount: 2, toolCount: 3 } })} />,
            );
            expect(container.querySelector('[data-testid="mcp-tool-calls"]')).toBeNull();
        });

        it('shows net input (input minus cache read) in dispatcher tiles and stop breakdown', () => {
            render(
                <TokensBlock
                    detail={detail({
                        tokenSummary: { input: 1000, output: 200, cacheRead: 800, source: 'stop' },
                        requestMetrics: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 },
                        stops: [{ harness: 'cursor', inputTokens: 1000, outputTokens: 200, cacheRead: 800, modelId: 'composer-2.5' }],
                    })}
                />,
            );
            const card = screen.getByTestId('tokens-block');
            expect(card.textContent).toContain('Net input');
            expect(card.textContent).toContain('200'); // 1000 - 800
            expect(card.textContent).toContain('input − cache');
            expect(card.textContent).toContain('net in');
        });
    });
});
