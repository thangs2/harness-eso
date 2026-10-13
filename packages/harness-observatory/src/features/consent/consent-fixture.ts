import type { RequestConsentVm } from '@/shared/api/types';

/** W0 acceptance fixture — insufficient + playbook + continue waiver */
export const consentFixtureInsufficient: RequestConsentVm = {
    eso: {
        sufficiency: 'insufficient',
        score: 0.33,
        gaps: [{ id: 'law:harness-tooling', kind: 'law', message: 'Read harness-tooling shard' }],
        recoveryPlaybook: [
            { id: 'pb-1', label: 'Run docgraph for harness-tooling' },
            { id: 'pb-2', label: 'Read core.harness-eso.mdc' },
        ],
    },
    consent: { outcome: 'continue', at: '2026-10-12T00:00:00Z', waiverId: 'waiver-qc-001' },
    preflight: { injectBrainBlock: true },
    policySnapshot: { eso: { cognition: { insufficientPromptGate: 'consent' } } },
};
