import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsentGateCard, shouldShowConsentCard } from './ConsentGateCard';
import { consentFixtureInsufficient } from './consent-fixture';

describe('ConsentGateCard', () => {
    it('renders insufficient fixture with playbook and waiver id', () => {
        render(<ConsentGateCard {...consentFixtureInsufficient} />);
        expect(screen.getByTestId('consent-gate-card')).toBeTruthy();
        expect(screen.getByTestId('consent-sufficiency').textContent).toMatch(/insufficient/);
        expect(screen.getByTestId('consent-playbook').querySelectorAll('li').length).toBe(2);
        expect(screen.getByTestId('consent-waiver-id').textContent).toMatch(/waiver-qc-001/);
    });

    it('hidden when sufficient and no gaps', () => {
        const { container } = render(
            <ConsentGateCard eso={{ sufficiency: 'sufficient', score: 0.9, gaps: [] }} />,
        );
        expect(container.querySelector('[data-testid="consent-gate-card"]')).toBeNull();
    });

    it('rounds the raw ratio so the card never shows seventeen decimal places', () => {
        render(<ConsentGateCard eso={{ sufficiency: 'insufficient', score: 0.3666666666666667, gaps: [] }} />);
        expect(screen.getByTestId('consent-sufficiency').textContent).toContain('0.37');
        expect(screen.getByTestId('consent-sufficiency').textContent).not.toContain('0.36666666');
    });

    it('draws threshold ticks only when policy supplied them', () => {
        const { container: withTicks } = render(
            <ConsentGateCard
                eso={{ sufficiency: 'insufficient', score: 0.37, gaps: [] }}
                policySnapshot={{ eso: { thresholds: { T_low: 0.45, T_high: 0.72 } } }}
            />,
        );
        expect(withTicks.querySelectorAll('.consent-tick').length).toBe(2);

        // No thresholds in the snapshot -> no ticks, rather than invented bands that could
        // disagree with the verdict the kernel already reached.
        const { container: without } = render(
            <ConsentGateCard
                eso={{ sufficiency: 'insufficient', score: 0.37, gaps: [] }}
                policySnapshot={{ eso: { cognition: { insufficientPromptGate: 'consent' } } }}
            />,
        );
        expect(without.querySelectorAll('.consent-tick').length).toBe(0);
    });

    it('exposes the level so callers can lay out around the card', () => {
        expect(shouldShowConsentCard(consentFixtureInsufficient)).toBe(true);
        expect(shouldShowConsentCard({ eso: { sufficiency: 'sufficient', score: 0.9, gaps: [] } })).toBe(false);
        // A consent gate still has something to say even on a sufficient turn.
        expect(
            shouldShowConsentCard({
                eso: { sufficiency: 'sufficient', score: 0.9, gaps: [] },
                policySnapshot: { eso: { cognition: { insufficientPromptGate: 'consent' } } },
            }),
        ).toBe(true);
    });
});
