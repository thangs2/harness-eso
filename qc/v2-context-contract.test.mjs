import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    compilePinnedInvariants,
    loadContextContract,
    resolveDomainContract,
    buildPreflightProjection,
    extractPinnedInvariants,
} from '@mu/harness-eso-core';

function tempConsumerWithContract(contractObj = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-contract-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sdlc', '00.governance'), { recursive: true });

    if (contractObj) {
        fs.writeFileSync(
            path.join(root, 'sdlc', '00.governance', '00.context-contract.json'),
            JSON.stringify(contractObj, null, 2),
        );
    }

    return root;
}

test('loadContextContract returns contractMissing=true when file is absent without throwing', () => {
    const root = tempConsumerWithContract(null);
    try {
        const contract = loadContextContract(root);
        assert.equal(contract.contractMissing, true);
        assert.deepEqual(contract.domains, {});
        assert.deepEqual(contract.globalInvariants, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('loadContextContract loads and parses valid context contract JSON', () => {
    const sampleContract = {
        version: 1,
        globalInvariants: ['INV-PROJECT-01'],
        domains: {
            bookings: {
                keywords: ['booking', 'appointment', 'reservation'],
                paths: ['src/modules/bookings/**'],
                requiredInvariants: ['INV-BOOKING-01', 'INV-BOOKING-02'],
            },
            billing: {
                keywords: ['invoice', 'billing', 'payment'],
                paths: ['src/modules/billing/**'],
                requiredInvariants: ['INV-BILLING-01'],
            },
        },
    };

    const root = tempConsumerWithContract(sampleContract);
    try {
        const contract = loadContextContract(root);
        assert.equal(contract.contractMissing, false);
        assert.equal(contract.version, 1);
        assert.deepEqual(contract.globalInvariants, ['INV-PROJECT-01']);
        assert.ok(contract.domains.bookings);
        assert.ok(contract.domains.billing);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveDomainContract matches domain by keyword in query stem', () => {
    const contract = {
        domains: {
            bookings: {
                keywords: ['booking', 'appointment'],
                requiredInvariants: ['INV-BOOKING-01'],
            },
            identity: {
                keywords: ['login', 'auth', 'user'],
                requiredInvariants: ['INV-AUTH-01'],
            },
        },
    };

    const r1 = resolveDomainContract(contract, { stem: 'Refactor booking calendar service' });
    assert.equal(r1.domain, 'bookings');
    assert.equal(r1.matchedBy, 'keyword');
    assert.deepEqual(r1.requiredInvariants, ['INV-BOOKING-01']);

    const r2 = resolveDomainContract(contract, { stem: 'Fix user login session token' });
    assert.equal(r2.domain, 'identity');
    assert.equal(r2.matchedBy, 'keyword');

    const r3 = resolveDomainContract(contract, { stem: 'General cleanup task' });
    assert.equal(r3.domain, 'default');
    assert.equal(r3.matchedBy, 'none');
});

test('resolveDomainContract matches domain by file paths', () => {
    const contract = {
        domains: {
            bookings: {
                paths: ['apps/web/src/modules/bookings/**'],
                requiredInvariants: ['INV-BOOKING-01'],
            },
        },
    };

    const res = resolveDomainContract(contract, {
        paths: ['apps/web/src/modules/bookings/BookingModal.tsx'],
    });
    assert.equal(res.domain, 'bookings');
    assert.equal(res.matchedBy, 'path');
});

test('compilePinnedInvariants calculates union with globals and intersects with attested', () => {
    const contract = {
        globalInvariants: ['INV-PROJECT-01'],
        domains: {
            bookings: {
                keywords: ['booking'],
                requiredInvariants: ['INV-BOOKING-01', 'INV-BOOKING-02'],
            },
        },
    };

    // Attested evidence contains various invariants discovered during turn
    const context = {
        stem: 'Create new booking appointment',
        attestedInvariants: ['INV-BOOKING-01', 'INV-PROJECT-01', 'INV-UNRELATED-99'],
    };

    const compiled = compilePinnedInvariants(contract, context);
    assert.equal(compiled.domain, 'bookings');
    assert.equal(compiled.contractMissing, false);
    // Pinned should contain only relevant invariants: INV-PROJECT-01 (global) and INV-BOOKING-01 (domain)
    assert.ok(compiled.pinnedInvariants.includes('INV-PROJECT-01'));
    assert.ok(compiled.pinnedInvariants.includes('INV-BOOKING-01'));
    assert.ok(!compiled.pinnedInvariants.includes('INV-UNRELATED-99'));
});

test('preflight projection scopes pinnedInvariants to domain when contract exists', () => {
    const contractObj = {
        globalInvariants: ['INV-PROJECT-01'],
        domains: {
            bookings: {
                keywords: ['booking', 'appointment'],
                requiredInvariants: ['INV-BOOKING-01'],
            },
        },
    };

    const root = tempConsumerWithContract(contractObj);
    try {
        const turn = {
            turnId: 'turn-booking-1',
            conversationId: 'sess-booking',
            userQueryStem: 'Implement appointment booking slot',
            fingerprint: 'fp-book',
        };

        const turnResult = {
            verdict: { sufficiency: { level: 'sufficient', score: 1.0, gaps: [] } },
            retrieval: {
                snippets: [
                    {
                        kind: 'law',
                        text: '- **INV-BOOKING-01**: Must check slot availability\n- **INV-PROJECT-01**: Validate project isolation\n- **INV-BILLING-09**: Invoice required',
                    },
                ],
            },
        };

        const projection = buildPreflightProjection(turn, turnResult, { root });
        assert.equal(projection.contractMissing, false);
        assert.equal(projection.domain, 'bookings');
        assert.ok(projection.pinnedInvariants.includes('INV-BOOKING-01'));
        assert.ok(projection.pinnedInvariants.includes('INV-PROJECT-01'));
        // Unrelated invariant is excluded from pinned set
        assert.ok(!projection.pinnedInvariants.includes('INV-BILLING-09'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
