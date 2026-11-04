import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    judgeSufficiency,
    formatGapReport,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-18 (AC-SUF-05-01): Every gap item specifies a valid source in [bar, work, blast, declared]', () => {
    const requirements = [
        { subject: 'gap-bar-item', asks: 'rule', min_basis: 'verified', source: 'bar' },
        { subject: 'gap-work-item', asks: 'rule', min_basis: 'verified', source: 'work' },
        { subject: 'gap-blast-item', asks: 'rule', min_basis: 'verified', source: 'blast' },
        { subject: 'gap-decl-item', asks: 'rule', min_basis: 'verified', source: 'declared' },
    ];

    const verdict = judgeSufficiency({
        requirements,
        answers: [],
    });

    const report = formatGapReport(verdict);
    assert.equal(report.gap_items.length, 4);
    assert.deepEqual(
        report.gap_items.map((g) => g.source),
        ['bar', 'work', 'blast', 'declared']
    );
});

test('SCN-SUF-19 (AC-SUF-05-02): level < sufficient without gap details is rejected with NO_GAP_DETAIL', () => {
    const corruptedVerdict = {
        level: 'insufficient',
        gaps: [],
    };

    assert.throws(() => {
        formatGapReport(corruptedVerdict);
    }, (err) => err.code === 'NO_GAP_DETAIL' || /NO_GAP_DETAIL/.test(err.message));
});

test('SCN-SUF-20 (AC-SUF-05-03): Gap item with exists=unknown is displayed as unknown, NOT as missing/thiếu', () => {
    const requirements = [
        { subject: 'unindexed-item', asks: 'doc', min_basis: 'verified', source: 'blast' },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'unindexed-item', claim: null, basis: 'inferred', exists: 'unknown' }],
    });

    const report = formatGapReport(verdict);
    assert.equal(report.gap_items.length, 1);
    assert.equal(report.gap_items[0].status, 'unknown');
    assert.equal(report.gap_items[0].exists, 'unknown');
    assert.notEqual(report.gap_items[0].status, 'missing');
});

test('SCN-SUF-21 (AC-SUF-05-04): Gaps ordered by source (bar < work < blast < declared) and blocking gaps first', () => {
    const requirements = [
        { subject: 'req-decl-absent', asks: 'spec', min_basis: 'verified', source: 'declared' },
        { subject: 'req-bar-unknown', asks: 'spec', min_basis: 'verified', source: 'bar' },
        { subject: 'req-bar-absent', asks: 'spec', min_basis: 'verified', source: 'bar' },
        { subject: 'req-blast-absent', asks: 'spec', min_basis: 'verified', source: 'blast' },
        { subject: 'req-work-absent', asks: 'spec', min_basis: 'verified', source: 'work' },
    ];

    const answers = [
        { requirement: 'req-decl-absent', claim: null, basis: 'inferred', exists: 'absent' },
        { requirement: 'req-bar-unknown', claim: null, basis: 'inferred', exists: 'unknown' },
        { requirement: 'req-bar-absent', claim: null, basis: 'inferred', exists: 'absent' },
        { requirement: 'req-blast-absent', claim: null, basis: 'inferred', exists: 'absent' },
        { requirement: 'req-work-absent', claim: null, basis: 'inferred', exists: 'absent' },
    ];

    const verdict = judgeSufficiency({ requirements, answers });
    const report = formatGapReport(verdict);

    assert.equal(report.gap_items.length, 5);
    // 1. req-bar-absent (bar, absent)
    assert.equal(report.gap_items[0].what, 'req-bar-absent');
    // 2. req-bar-unknown (bar, unknown)
    assert.equal(report.gap_items[1].what, 'req-bar-unknown');
    // 3. req-work-absent (work, absent)
    assert.equal(report.gap_items[2].what, 'req-work-absent');
    // 4. req-blast-absent (blast, absent)
    assert.equal(report.gap_items[3].what, 'req-blast-absent');
    // 5. req-decl-absent (declared, absent)
    assert.equal(report.gap_items[4].what, 'req-decl-absent');
});

test('SCN-SUF-34 (AC-SUF-05-05): 50 gap items order is fully reproducible between two executions', () => {
    const requirements = [];
    const sources = ['declared', 'blast', 'work', 'bar'];

    for (let i = 0; i < 50; i++) {
        requirements.push({
            subject: `stress-item-${i}`,
            asks: 'check',
            min_basis: 'verified',
            source: sources[i % 4],
        });
    }

    const answers = requirements.map((r, i) => ({
        requirement: r.subject,
        claim: null,
        basis: 'inferred',
        exists: i % 3 === 0 ? 'absent' : 'unknown',
    }));

    const v1 = judgeSufficiency({ requirements, answers });
    const v2 = judgeSufficiency({ requirements, answers });

    const r1 = formatGapReport(v1);
    const r2 = formatGapReport(v2);

    assert.equal(r1.gap_items.length, 50);
    assert.deepEqual(r1.gap_items, r2.gap_items);
});

test('SCN-SUF-35 (AC-SUF-05-06): Deleted source requirement preserved with "nguồn đã mất" and dangling_source=true', () => {
    const requirements = [
        { subject: 'deleted-role-gap', asks: 'rule', min_basis: 'verified', source: 'work', source_gone: true },
    ];
    const verdict = judgeSufficiency({
        requirements,
        answers: [{ requirement: 'deleted-role-gap', claim: null, basis: 'inferred', exists: 'absent' }],
    });

    const report = formatGapReport(verdict);
    assert.equal(report.gap_items.length, 1);
    assert.equal(report.gap_items[0].dangling_source, true);
    assert.equal(report.gap_items[0].where_hint, 'nguồn đã mất');
});

test('SCN-SUF-40 (AC-SUF-05-07 & 4.3-T): Missing graph yields cannot-judge, never insufficient, with basis=declared', () => {
    // Case A: Missing graph -> cannot-judge
    const verdictA = judgeSufficiency({
        requirements: [],
        graph: { built: false, missing: true },
    });

    assert.equal(verdictA.level, 'cannot-judge');
    assert.equal(verdictA.basis, 'declared');
    assert.equal(verdictA.cannot_judge_reason, 'missing_graph');
    assert.notEqual(verdictA.level, 'insufficient');

    // Case B: Graph present (completeness=0.97) with 2 absent requirements -> insufficient
    const verdictB = judgeSufficiency({
        requirements: [
            { subject: 'api-contract-1', asks: 'spec', min_basis: 'verified', source: 'blast' },
            { subject: 'api-contract-2', asks: 'spec', min_basis: 'verified', source: 'blast' },
        ],
        answers: [
            { requirement: 'api-contract-1', claim: null, basis: 'inferred', exists: 'absent' },
            { requirement: 'api-contract-2', claim: null, basis: 'inferred', exists: 'absent' },
        ],
        graph: { built: true, completeness: 0.97 },
    });

    assert.equal(verdictB.level, 'insufficient');
    assert.equal(verdictB.gaps.length, 2);
    assert.notEqual(verdictA.level, verdictB.level);
});
