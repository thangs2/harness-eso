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
});
