import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    explainTurnVerdict,
} from '../eso/core/src/index.mjs';

test('SCN-SUF-15 (AC-SUF-04-01): Asking "vì sao" returns four parts with valid cites[]', () => {
    const turnRecord = {
        project: 'proj-suf-15',
        turn_id: 'turn-15',
        at: '2026-11-04T02:00:00.000Z',
        level: 'insufficient',
        mode: 'ask',
        basis: 'retrieved',
        rule_version: '1.0.0',
        payload: {
            requirements: [
                { subject: 'data-sanitization', asks: 'rules', min_basis: 'verified', source: 'bar' },
            ],
            answers: [
                { requirement: 'data-sanitization', claim: null, basis: 'inferred', exists: 'absent' },
            ],
            files_used: [{ path: 'src/cleaner.ts' }],
            unknowns: [],
        },
    };

    const result = explainTurnVerdict({
        project: 'proj-suf-15',
        turn_id: 'turn-15',
        turnRecord,
    });

    // Part 1: Unmet requirements with cites
    assert.equal(result.unmet.length, 1);
    assert.equal(result.unmet[0].subject, 'data-sanitization');
    assert(result.unmet[0].cites.length >= 1);
    assert.equal(result.unmet[0].cites[0].kind, 'requirement');

    // Part 2: Missing evidence with cites
    assert.equal(result.missing_evidence.length, 1);
    assert.equal(result.missing_evidence[0].requirement, 'data-sanitization');
    assert(result.missing_evidence[0].cites.length >= 1);

    // Part 3: Prior conclusion (read directly, not recomputed)
    assert.equal(result.prior_conclusion.level, 'insufficient');
    assert.equal(result.prior_conclusion.mode, 'ask');
    assert.equal(result.prior_conclusion.basis, 'retrieved');
    assert.equal(result.prior_conclusion.at, '2026-11-04T02:00:00.000Z');

    // Part 4: Unknowns[]
    assert(Array.isArray(result.unknowns));
});

test('SCN-SUF-16 (AC-SUF-04-02): Surfaces unknown item in unknowns[] with count > 0', () => {
    const turnRecord = {
        project: 'proj-suf-16',
        turn_id: 'turn-16',
        level: 'cannot-judge',
        mode: 'ask',
        basis: 'declared',
        rule_version: '1.0.0',
        payload: {
            requirements: [{ subject: 'unindexed-lib', asks: 'signature', min_basis: 'verified', source: 'blast' }],
            answers: [{ requirement: 'unindexed-lib', claim: null, basis: 'inferred', exists: 'unknown', reason: 'chưa index' }],
            files_used: [{ path: 'lib/unindexed.js' }],
        },
    };

    const result = explainTurnVerdict({
        project: 'proj-suf-16',
        turn_id: 'turn-16',
        turnRecord,
    });

    assert(result.unknowns.length > 0);
    const item = result.unknowns.find((u) => u.what === 'unindexed-lib');
    assert(item);
    assert.equal(item.exists, 'unknown');
    assert.equal(item.reason, 'chưa index');
});

test('SCN-SUF-17 (AC-SUF-04-03): Missing turn record throws NO_RECORD ("không có bản ghi")', () => {
    assert.throws(() => {
        explainTurnVerdict({
            project: 'proj-suf-17',
            turn_id: 'turn-missing-record',
            turnRecord: null,
        });
    }, (err) => err.code === 'NO_RECORD' || /NO_RECORD/.test(err.message) || /không có bản ghi/.test(err.message));
});

test('SCN-SUF-32 (AC-SUF-04-04 & ED1): Turn that read 0 files states "không có bằng chứng" + unknowns entry, never infers evidence', () => {
    const turnRecord = {
        project: 'proj-suf-32',
        turn_id: 'turn-32',
        level: 'cannot-judge',
        mode: 'ask',
        basis: 'declared',
        rule_version: '1.0.0',
        payload: {
            requirements: [],
            answers: [],
            files_used: [],
        },
    };

    const result = explainTurnVerdict({
        project: 'proj-suf-32',
        turn_id: 'turn-32',
        turnRecord,
    });

    assert.equal(result.evidence_empty, true);
    assert.equal(result.evidence_note, 'không có bằng chứng');
    assert(result.unknowns.some((u) => u.what === 'evidence' && u.reason.includes('không có bằng chứng')));
});

test('SCN-SUF-33 (AC-SUF-04-05 & ED10): Turn referencing deleted file notes file is gone ("nguồn đã mất") as unknown (NOT absent)', () => {
    const turnRecord = {
        project: 'proj-suf-33',
        turn_id: 'turn-33',
        level: 'insufficient',
        mode: 'ask',
        basis: 'retrieved',
        rule_version: '1.0.0',
        payload: {
            files_used: [{ path: 'legacy/removed_service.ts', gone: true, dangling: true }],
        },
    };

    const result = explainTurnVerdict({
        project: 'proj-suf-33',
        turn_id: 'turn-33',
        turnRecord,
    });

    const goneFile = result.unknowns.find((u) => u.what === 'legacy/removed_service.ts');
    assert(goneFile, 'Deleted file must appear in unknowns[]');
    assert.equal(goneFile.exists, 'unknown', 'Deleted file must be flagged as unknown, NEVER absent');
    assert(goneFile.reason.includes('nguồn đã mất') || goneFile.reason.includes('file không còn'));
});
