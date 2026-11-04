import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SOURCES,
    LEVELS,
    MODES,
    BASES,
    deriveRequirements,
    judgeSufficiency,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-01 (AC-SUF-01-01): Each requirement has level and basis, no aggregate replaces them', () => {
    const requirements = deriveRequirements({
        bar: [{ subject: 'auth-jwt', asks: 'validation-logic', min_basis: 'retrieved' }],
        work: [{ subject: 'db-migration', asks: 'run-ddl', min_basis: 'verified' }],
    });

    const answers = [
        { requirement: 'auth-jwt', claim: 'JWT validator exists', basis: 'retrieved', exists: 'present' },
        { requirement: 'db-migration', claim: 'Migration applied', basis: 'verified', exists: 'present' },
    ];

    const verdict = judgeSufficiency({ requirements, answers });

    assert.equal(verdict.level, 'sufficient');
    assert.equal(verdict.requirements.length, 2);

    assert.equal(verdict.requirements[0].subject, 'auth-jwt');
    assert.equal(verdict.requirements[0].level, 'sufficient');
    assert.equal(verdict.requirements[0].basis, 'retrieved');
    assert.equal(verdict.requirements[0].source, 'bar');

    assert.equal(verdict.requirements[1].subject, 'db-migration');
    assert.equal(verdict.requirements[1].level, 'sufficient');
    assert.equal(verdict.requirements[1].basis, 'verified');
    assert.equal(verdict.requirements[1].source, 'work');
});

test('SCN-SUF-02 (AC-SUF-01-02): Untraceable requirement is cannot-judge with reason in unknowns, unknown != absent', () => {
    const requirements = deriveRequirements({
        declared: [{ subject: 'unindexed-rule', asks: 'rule-check', min_basis: 'retrieved' }],
    });

    const verdict = judgeSufficiency({ requirements, answers: [] });

    assert.equal(verdict.level, 'cannot-judge');
    assert.equal(verdict.requirements[0].level, 'cannot-judge');
    assert.equal(verdict.requirements[0].exists, 'unknown');
    assert.notEqual(verdict.requirements[0].exists, 'absent');

    assert.equal(verdict.unknowns.length, 1);
    assert.equal(verdict.unknowns[0].what, 'unindexed-rule');
    assert.match(verdict.unknowns[0].reason, /không tra được/);
});

test('SCN-SUF-03 (AC-SUF-01-03): Gaps list is finite, countable, includes what + where_hint, never drops unknown origin', () => {
    const requirements = [
        { subject: 'req-with-hint', asks: 'check-1', min_basis: 'verified', source: 'declared', where_hint: 'specs/api.md' },
        { subject: 'req-without-hint', asks: 'check-2', min_basis: 'verified', source: 'bar', where_hint: null },
    ];

    const answers = [
        { requirement: 'req-with-hint', claim: null, basis: 'inferred', exists: 'absent' },
        { requirement: 'req-without-hint', claim: null, basis: 'inferred', exists: 'absent' },
    ];

    const verdict = judgeSufficiency({ requirements, answers });

    assert.equal(verdict.level, 'insufficient');
    assert.equal(verdict.gaps.length, 2);

    assert.equal(verdict.gaps[0].what, 'req-without-hint');
    assert.match(verdict.gaps[0].where_hint, /từ nguồn bar|không rõ nguồn/);

    assert.equal(verdict.gaps[1].what, 'req-with-hint');
    assert.equal(verdict.gaps[1].where_hint, 'specs/api.md');
});

test('SCN-SUF-04 (AC-SUF-01-04): Host lacking capability yields cannot-judge + named capability, assurance DEGRADED', () => {
    const requirements = [
        { subject: 'deep-analysis', asks: 'ast deep analysis', min_basis: 'verified', source: 'work', required_capability: 'docgraph' },
    ];

    const verdict = judgeSufficiency({
        requirements,
        host: { missing_capabilities: ['docgraph'] },
    });

    assert.equal(verdict.level, 'cannot-judge');
    assert.equal(verdict.assurance, 'DEGRADED');
    assert.equal(verdict.unknowns.length, 1);
    assert.equal(verdict.unknowns[0].missing_capability, 'docgraph');
    assert.match(verdict.unknowns[0].reason, /host thiếu năng lực: docgraph/);
});

test('SCN-SUF-05 (AC-SUF-01-05): Verdict does not automatically change mode; mode is selected and recorded separately', () => {
    const requirements = [
        { subject: 'unmet-ac', asks: 'full coverage', min_basis: 'verified', source: 'work' },
    ];

    const answers = [
        { requirement: 'unmet-ac', claim: null, basis: 'inferred', exists: 'absent' },
    ];

    const verdict = judgeSufficiency({
        requirements,
        answers,
        mode: 'ask',
        mode_selected_by: 'lead-developer',
    });

    assert.equal(verdict.level, 'insufficient');
    assert.equal(verdict.mode, 'ask');
    assert.equal(verdict.mode_selected_by, 'lead-developer');
    assert.notEqual(verdict.mode, 'block');
});

test('SCN-SUF-06 (AC-SUF-01-06 / ED4): basis == min_basis is satisfied (sufficient if no other requirement is unsat)', () => {
    const requirements = [
        { subject: 'boundary-check', asks: 'verify-proof', min_basis: 'retrieved', source: 'blast' },
    ];

    const answers = [
        { requirement: 'boundary-check', claim: 'retrieved answer', basis: 'retrieved', exists: 'present' },
    ];

    const verdict = judgeSufficiency({ requirements, answers });

    assert.equal(verdict.level, 'sufficient');
    assert.equal(verdict.basis, 'retrieved');
    assert.equal(verdict.sat.length, 1);
    assert.equal(verdict.unsat.length, 0);
});

test('SCN-SUF-07 (AC-SUF-01-07 / ED1): Empty requirements list yields cannot-judge + không có gì để yêu cầu, never sufficient', () => {
    const verdict = judgeSufficiency({ requirements: [] });

    assert.equal(verdict.level, 'cannot-judge');
    assert.equal(verdict.basis, 'declared');
    assert.notEqual(verdict.level, 'sufficient');
    assert.equal(verdict.unknowns.length, 1);
    assert.equal(verdict.unknowns[0].reason, 'không có gì để yêu cầu');
});

test('SCN-SUF-38 (AC-SUF-01-08): Requirement missing source or invalid source rejected with SOURCE_MISSING, 0 requirements loaded', () => {
    assert.throws(() => {
        deriveRequirements({
            work: [{ subject: 'no-src-req', asks: 'something', min_basis: 'retrieved', source: null }],
        });
    }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));

    assert.throws(() => {
        deriveRequirements({
            blast: [{ subject: 'ai-src-req', asks: 'something', min_basis: 'retrieved', source: 'ai' }],
        });
    }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));

    assert.throws(() => {
        judgeSufficiency({
            requirements: [{ subject: 'untyped-req', asks: 'something', min_basis: 'retrieved' }],
        });
    }, (err) => err.code === 'SOURCE_MISSING' || /SOURCE_MISSING/.test(err.message));
});

test('SCN-SUF-26 (INV-ESO-01 & INV-ESO-02): cannot-judge never becomes permitted without explicit bypass', () => {
    const requirements = [
        { subject: 'unverified-feature', asks: 'proof', min_basis: 'verified', source: 'work' },
    ];

    const verdict = judgeSufficiency({
        requirements,
        answers: [],
        mode: 'permitted',
    });

    assert.equal(verdict.level, 'cannot-judge');
    assert.equal(verdict.mode, 'ask');
});

test('SCN-SUF-27 (Section 6.2): Per-requirement min_basis ensures distinct satisfaction per requirement', () => {
    const requirements = [
        { subject: 'req-inferred', asks: 'design-hint', min_basis: 'inferred', source: 'declared' },
        { subject: 'req-verified', asks: 'security-proof', min_basis: 'verified', source: 'bar' },
    ];

    const answers = [
        { requirement: 'req-inferred', claim: 'got retrieved', basis: 'retrieved', exists: 'present' },
        { requirement: 'req-verified', claim: 'got retrieved only', basis: 'retrieved', exists: 'present' },
    ];

    const verdict = judgeSufficiency({ requirements, answers });

    assert.equal(verdict.level, 'partial');
    assert.equal(verdict.ratio, '1/2');
    assert.equal(verdict.sat.length, 1);
    assert.equal(verdict.sat[0].subject, 'req-inferred');
    assert.equal(verdict.unsat.length, 1);
    assert.equal(verdict.unsat[0].subject, 'req-verified');
});
