import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RequestDetailHeader } from './RequestDetailHeader';
import type { RequestDetailResponse } from '@/shared/api/types';

const TOKENS = { input: 235625, output: 3656, cacheRead: 188042 };

function detail(): RequestDetailResponse {
    return {
        request: {
            userQuery: 'a turn that spent a lot of context',
            boundaryIndex: 1,
            status: 'completed',
            startedAt: '2026-10-12T13:15:00Z',
            endedAt: '2026-10-12T13:16:18Z',
            conversationId: '981fd768-3b48-447c-85fb-98f2a6bfbda1',
            generationId: '981fd768-3b48-447c-85fb-98f2a6bfbda1:1',
        },
        requestMetrics: {
            callCount: 6,
            toolCount: 16,
            inputTokens: TOKENS.input,
            outputTokens: TOKENS.output,
            cacheReadTokens: TOKENS.cacheRead,
            modelId: 'composer-2.5',
        },
        tokenSummary: { ...TOKENS, source: 'request' },
        eso: { sufficiency: 'insufficient', score: 0.37, gaps: [] },
    } as RequestDetailResponse;
}

const renderHeader = (d: RequestDetailResponse = detail()) =>
    render(
        <MemoryRouter>
            <RequestDetailHeader detail={d} id="981fd768-3b48-447c-85fb-98f2a6bfbda1:1" />
        </MemoryRouter>,
    );

describe('RequestDetailHeader', () => {
    it('keeps identity facts and does NOT restate cost', () => {
        // Regression: this strip used to repeat Token in/out, Cache read, Calls, Tools and
        // Model — all of which the Tokens & cost card reports from the same fields, so the
        // page stated each number twice and the two copies could disagree.
        const { container } = renderHeader();
        const facts = [...container.querySelectorAll('.request-fact')].map((f) => f.textContent ?? '');

        expect(facts.join(' | ')).toContain('duration');
        expect(facts.join(' | ')).toContain('1m 18s');
        expect(facts.join(' | ')).toContain('composer-2.5');

        // None of the cost figures may appear anywhere in the hero.
        const hero = container.querySelector('.request-detail-hero')?.textContent ?? '';
        expect(hero).not.toContain('235,625');
        expect(hero).not.toContain('3,656');
        expect(hero).not.toContain('188,042');
        // Nor the volume counters, nor the old tile labels.
        expect(hero).not.toMatch(/Token in|Token out|Cache read/i);
        expect(hero).not.toMatch(/\bCalls\b/);
    });

    it('does not print `ended` as a second copy of `started`', () => {
        // `started` + `duration` already determine the end; two "9h ago" facts read as a
        // duplicated column rather than as information.
        const { container } = renderHeader();
        const labels = [...container.querySelectorAll('.request-fact-label')].map((l) =>
            (l.textContent ?? '').toLowerCase(),
        );
        expect(labels).toContain('started');
        expect(labels).toContain('duration');
        expect(labels).not.toContain('ended');
    });

    it('still surfaces status and sufficiency as badges', () => {
        renderHeader();
        expect(screen.getByText('completed')).toBeTruthy();
        expect(screen.getByText(/ESO insufficient/)).toBeTruthy();
    });

    it('omits the duration when the turn has not ended', () => {
        const d = detail();
        d.request = { ...(d.request as Record<string, unknown>), endedAt: null };
        const { container } = renderHeader(d);
        const labels = [...container.querySelectorAll('.request-fact-label')].map((l) =>
            (l.textContent ?? '').toLowerCase(),
        );
        expect(labels).toContain('started');
        expect(labels).not.toContain('duration');
    });
});
