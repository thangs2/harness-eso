/**
 * Regression tests for the gap-closure defects found on 2026-10-22 (H1–H5).
 *
 * Each test states the failure it prevents, because a test that names the bug is the only kind a
 * reader can trust when it goes green. The four consumer sessions are in `comments/artifacts/`; the
 * analysis is `documents/03.state-and-contracts/06.evidence-sufficiency-defects.md`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    bundleStampPath,
    closesGap,
    gapKindsForTool,
    recordGapToolUse,
    shouldBlockBrain,
} from './eso-gap-io.mjs';
import { detectGaps, runCollect, scoreSufficiency } from '@mu/harness-eso-core';

function tempRoot(prefix = 'eso-gap-reg-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    return root;
}

/** The stamp as a reader sees it, or `null` when no file was written yet. */
function readBundleStamp(root, tree = 'cursor') {
    try {
        return JSON.parse(fs.readFileSync(bundleStampPath(root, tree), 'utf8'));
    } catch {
        return null;
    }
}

function seedPreflight(root, gaps, extra = {}) {
    const sessionPath = path.join(root, '.cursor', 'session');
    const preflight = {
        at: '2026-10-22T13:24:25Z',
        level: 'insufficient',
        score: 0.1833,
        allowWrite: false,
        enforceWrites: 'fail_closed',
        mode: 'fail_closed',
        gaps,
        ...extra,
    };
    fs.writeFileSync(path.join(sessionPath, '.eso-preflight.json'), JSON.stringify(preflight));
    return preflight;
}

/* ── H1 · a law gap naming a `core.*` rule must be closable by reading that rule ───────────────── */

test('H1: reading .cursor/rules/core.pipeline-gate.mdc closes law:pipeline-gate', () => {
    const gap = { kind: 'law', query: 'pipeline-gate' };
    const input = { path: '.cursor/rules/core.pipeline-gate.mdc' };
    const kinds = gapKindsForTool('Read', input);

    assert.equal(
        closesGap(gap, kinds, input, 'Read'),
        true,
        'the dot in `core.` breaks the raw substring test — every consumer rule is named core.*/stack.*/delivery.*',
    );
});

test('H1: an underscore/hyphen variant of the same stem also closes it', () => {
    const gap = { kind: 'law', query: 'harness-tooling' };
    const input = { path: 'rules/core.harness_tooling.mdc' };
    assert.equal(closesGap(gap, gapKindsForTool('Read', input), input, 'Read'), true);
});

test('H1: reading AGENTS.md does NOT close law:pipeline-gate', () => {
    const gap = { kind: 'law', query: 'pipeline-gate' };
    const input = { path: 'AGENTS.md' };
    assert.equal(closesGap(gap, gapKindsForTool('Read', input), input, 'Read'), false);
});

test('H1: reading a rule whose stem merely RESEMBLES the term does not close it', () => {
    const gap = { kind: 'law', query: 'pipeline-gate' };
    const input = { path: '.cursor/rules/core.pipeline-gates-archive.mdc' };
    assert.equal(closesGap(gap, gapKindsForTool('Read', input), input, 'Read'), false);
});

/* ── H4 · a required term that is not a law query can never be fetched ────────────────────────── */

test('H4: runCollect fetches every requiredDocTerm, not only lawQueries', async () => {
    const fetched = [];
    const registry = {
        resolve: (kind) =>
            kind === 'law'
                ? {
                      async fetch(q) {
                          fetched.push(String(q?.query ?? q));
                          return { snippets: [], trace: `stub:${q?.query ?? q}` };
                      },
                  }
                : null,
    };
    const policy = {
        skillPacks: {
            tools: {
                requiredDocTerms: ['harness-tooling', 'decision-facade', 'harness-eso'],
                lawQueries: ['harness-tooling', 'decision-facade'],
                minReadPaths: 1,
                codeQueries: [],
            },
        },
        eso: { sources: {} },
    };

    await runCollect(
        {},
        {
            policy,
            eso: { thresholds: { T_low: 0.45, T_high: 0.72 }, memoryFetch: false },
            surface: { bucket: 'tools' },
            stem: 'test',
            root: os.tmpdir(),
            registry,
        },
    );

    assert.ok(
        fetched.includes('harness-eso'),
        `harness-eso is a requiredDocTerm but was never fetched, so law:harness-eso is unclosable (fetched: ${fetched.join(', ')})`,
    );
});

test('H4: detectGaps emits no law gap when the fetched law text covers the requirement', () => {
    const pack = { requiredDocTerms: ['harness-eso'], minReadPaths: 0 };
    const retrieval = { snippets: [{ kind: 'law', text: 'harness-eso dual harness law' }], reads: { readCount: 0 } };
    assert.deepEqual(detectGaps(pack, retrieval, 'stem'), []);
});

/* ── H2 + H3 · the score is re-measured, and the stamp follows every transition ───────────────── */

test('H2: a closure score is re-measured, never raised to a constant', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [
            { kind: 'law', query: 'harness-tooling' },
            { kind: 'law', query: 'decision-facade' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ]);
        recordGapToolUse('Read', { path: 'AGENTS.md' }, { root, tree: 'cursor' });

        const stamp = readBundleStamp(root, 'cursor');
        assert.ok(
            Number(stamp.score) < 0.85,
            `one of three gaps closed must not report 0.85 (got ${stamp.score}); the score has to agree with the gaps it is derived from`,
        );
        assert.equal(stamp.level, 'partial');
        assert.equal(stamp.allowWrite, false);
        assert.deepEqual(stamp.closure, { closed: 1, required: 3, allClosed: false });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('H3: partial progress is written to the stamp, not only the closure file', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [
            { kind: 'law', query: 'never-appears-anywhere' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ]);
        const res = recordGapToolUse('Read', { path: 'src/app.mjs' }, { root, tree: 'cursor' });
        assert.equal(res.allClosed, false);

        const stamp = readBundleStamp(root, 'cursor');
        assert.ok(stamp, 'the stamp must exist after the first closure change, not only when all gaps close');
        assert.ok(Number(stamp.score) > 0.1833, 'one of two gaps closed must score above the preflight floor');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('H2: a measurement at or above the high threshold may flip the stamp to allowWrite', () => {
    const pack = { requiredDocTerms: ['a', 'b'], minReadPaths: 1 };
    const { score, level } = scoreSufficiency(
        pack,
        { snippets: [{ kind: 'law', text: 'a b' }], reads: { readCount: 1 } },
        [],
        'stem',
        { T_low: 0.45, T_high: 0.72 },
    );
    assert.equal(score, 1);
    assert.equal(level, 'sufficient');
});

/* ── H5 · the code gap is about this project's source, not any path ───────────────────────────── */

test('H5: reading a skill file does not prove the project code was inspected', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const input = { path: '.cursor/skills/eso-recon/SKILL.md' };
    const kinds = gapKindsForTool('Read', input);
    assert.equal(closesGap(gap, kinds, input, 'Read', { root: '/repo/app' }), false);
});

test('H5: reading a file outside the preflight root does not close the code gap', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const input = { path: '/Users/someone/other-repo/src/index.mjs' };
    const kinds = gapKindsForTool('Read', input);
    assert.equal(closesGap(gap, kinds, input, 'Read', { root: '/repo/app' }), false);
});

test('H5: reading project source still closes the code gap', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const input = { path: 'packages/harness-host-generic/src/eso-gap-io.mjs' };
    const kinds = gapKindsForTool('Read', input);
    assert.equal(closesGap(gap, kinds, input, 'Read', { root: '/repo/app' }), true);
});

test('H5: a project-source read closes it even when codeQueries names a different prefix', () => {
    const gap = { kind: 'code', query: 'need at least 1 file read(s); have 0' };
    const input = { path: 'packages/harness-host-generic/src/eso-gap-io.mjs' };
    const kinds = gapKindsForTool('Read', input);
    assert.equal(
        closesGap(gap, kinds, input, 'Read', { root: '/repo/app', codeQueries: ['tools/harness'] }),
        true,
        'requiring codeQueries would reject real source recon — the `tools` pack lists `tools/harness`',
    );
});

/* ── P6 · the Brain gate is a consequence of the above, not a separate switch ─────────────────── */

test('P6: Brain opens as soon as the gaps it was waiting on are closed', () => {
    const preflight = { at: 'T0', level: 'insufficient', gaps: [{ kind: 'law', query: 'pipeline-gate' }] };
    const open = { preflightAt: 'T0', requiredGapIds: ['law:pipeline-gate'], closedGapIds: [], allClosed: false };
    const closed = { ...open, closedGapIds: ['law:pipeline-gate'], allClosed: true };
    const policy = { eso: { cognition: { enforceBrain: 'fail_closed' } } };

    assert.equal(shouldBlockBrain(preflight, open, policy), true);
    assert.equal(shouldBlockBrain(preflight, closed, policy), false);
});

/* ── H1 + H5 end to end · the shape that deadlocked `baplatform` ─────────────────────────────── */

test('deadlock scenario: reading the law rule and the source closes both gaps and unlocks the write', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [
            { kind: 'law', query: 'pipeline-gate' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ]);

        let res = recordGapToolUse('Read', { path: '.cursor/rules/core.pipeline-gate.mdc' }, { root, tree: 'cursor' });
        assert.ok(res.closedGapIds.includes('law:pipeline-gate'));

        res = recordGapToolUse('Read', { path: 'src/server.mjs' }, { root, tree: 'cursor' });
        assert.equal(res.allClosed, true);

        const stamp = readBundleStamp(root, 'cursor');
        assert.equal(stamp.allowWrite, true);
        assert.equal(stamp.level, 'sufficient');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
