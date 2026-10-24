import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateTurn } from '@mu/harness-eso-core';
import { detectGaps, scoreSufficiency } from '@mu/harness-eso-core';
import { loadHarnessProfile } from '@mu/harness-eso-core';
import { resolveEsoPolicy } from '@mu/harness-eso-core';

test('loadHarnessProfile generic-eso', () => {
    const { policy, profileId } = loadHarnessProfile('generic-eso');
    assert.equal(profileId, 'generic-eso');
    assert.equal(policy.eso?.enabled, true);
    const eso = resolveEsoPolicy(policy);
    assert.ok(eso.thresholds.T_high > eso.thresholds.T_low);
});

test('COLLECT detectGaps + score with injected law snippets', () => {
    const pack = { requiredDocTerms: ['harness-tooling'], minReadPaths: 1 };
    const retrieval = {
        snippets: [{ kind: 'law', text: 'harness-tooling core.harness' }],
        reads: { readCount: 0 },
    };
    const gaps = detectGaps(pack, retrieval, 'tiếp tục w2');
    assert.ok(gaps.some((g) => g.kind === 'code'));
    const measure = scoreSufficiency(pack, retrieval, gaps, 'tiếp tục w2', {
        T_low: 0.45,
        T_high: 0.72,
    });
    assert.ok(measure.score > 0);
});

test('GATE fail_closed blocks protected write when insufficient', async () => {
    const out = await orchestrateTurn(
        {
            event: 'turn_start',
            turnId: 'qc-1',
            userQueryStem: 'tiếp tục w2 harness',
            touchedPaths: ['tools/harness/README.md'],
        },
        {
            policy: {
                jev: { mode: 'off' },
                eso: {
                    enabled: true,
                    mode: 'hint',
                    enforceWrites: 'fail_closed',
                    thresholds: { T_low: 0.45, T_high: 0.72 },
                    cognition: { insufficientPromptGate: 'consent' },
                    /*
                     * Declared here because the product no longer ships a `tools` pack (G-01). Without
                     * a pack nothing is required, `gaps` is empty and the write is allowed — which would
                     * make this test assert the opposite of what it is named for.
                     */
                    skillPacks: { tools: { requiredDocTerms: ['harness-tooling'], minReadPaths: 1 } },
                },
            },
            injectSnippets: [],
            reads: { readCount: 0 },
        },
    );
    assert.equal(out.skipped, false);
    assert.equal(out.verdict.contractVersion, '1.0.0');
    assert.equal(out.verdict.enforceWrites, 'fail_closed');
    assert.equal(out.verdict.allowProtectedWrite, false);
    assert.ok(out.gaps.length >= 1);
});

test('orchestrateTurn sufficient when snippets satisfy pack', async () => {
    const lawBlob = 'harness-tooling decision-facade harness-eso documentation';
    const out = await orchestrateTurn(
        {
            event: 'turn_start',
            turnId: 'qc-2',
            userQueryStem: 'explain only',
            touchedPaths: ['tools/harness/foo.mjs'],
        },
        {
            policy: {
                jev: { mode: 'off' },
                eso: {
                    enabled: true,
                    mode: 'observe',
                    enforceWrites: 'off',
                    thresholds: { T_low: 0.45, T_high: 0.55 },
                },
            },
            injectSnippets: [{ kind: 'law', text: lawBlob }],
            reads: { readCount: 2, paths: ['a.mjs', 'b.mjs'] },
        },
    );
    assert.equal(out.measure.level, 'sufficient');
    assert.equal(out.verdict.allowProtectedWrite, true);
});

test('loadHarnessProfile fails loudly for a missing profile instead of degrading to defaults', () => {
    // Resolving `profiles/` from `__dirname` used to make a missing profile indistinguishable
    // from an empty one: `existsSync` false → `{}` → the caller silently lost every
    // `eso.thresholds` / `eso.mode` value. That is a silent change in what GATE decides.
    assert.throws(
        () => loadHarnessProfile('definitely-not-a-profile'),
        /not found.*HARNESS_PROFILES_DIR/s,
    );
});
