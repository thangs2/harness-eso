/**
 * G-01 / G-02 / G-03 — the gate may not demand evidence that its consumer cannot contain.
 *
 * The atrievefin case, reduced to its parts: a prompt that routes to bucket `root`, a policy that
 * names no sources, and a law adapter that answers nothing. Before the fix, that combination produced
 *
 *   pack  = tools  → requiredDocTerms ['harness-tooling', 'decision-facade', 'harness-eso']
 *   gaps  = law×3 + code×1, none of them closable by reading this repo
 *   score = 0, level = insufficient, allowWrite = false — every turn, in every session
 *
 * These tests pin the three decisions separately, so a later change to one cannot silently restore
 * another: the pack mapping (G-01), the naming of an unanswerable gap (G-02), and the write condition
 * under `fail_closed` (G-03). Register: `documents/05.development/09.gate-defect-register.md`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTurnVerdict, buildPreflightProjection, resolveSkillPack, runCollect, declaredSources, resolveEsoPolicy } from '@mu/harness-eso-core';
import { normalisePack, parseSkillPacks } from '@mu/harness-foundation/pure';
import { denyReasonFor } from './preflight-hook.mjs';
import { readLawMisses, rememberLawMisses, shouldBlockBrain } from './eso-gap-io.mjs';

/** A law adapter that answers nothing, the way a consumer's stale/foreign index does. */
const emptyLaw = {
    id: 'empty-law',
    kinds: ['law'],
    async fetch({ query }) {
        return { snippets: [], trace: `docgraph:miss:${query}` };
    },
};
const registry = { resolve: (kind) => (kind === 'law' ? emptyLaw : null) };

const ESO = { thresholds: { T_low: 0.45, T_high: 0.72 }, mode: 'hint', enforceWrites: 'fail_closed' };

test('G-01: no bucket ships built-in terms — an undeclared pack is empty', () => {
    /*
     * The original fix gave `root` its own pack and kept `tools` carrying `harness-tooling`. That still
     * left the product shipping one consumer's domain terms to every consumer, which is the disease
     * G-01 describes; the table has since been deleted. What must hold now: **every** bucket, named or
     * invented, resolves to an empty undeclared pack until the consumer declares one.
     */
    for (const bucket of ['root', 'tools', 'backend', 'frontend', 'docs', 'general', 'never-heard-of-it']) {
        const pack = resolveSkillPack({ bucket });
        assert.equal(pack.bucket, bucket);
        assert.equal(pack.declared, false, `${bucket} must be undeclared, not silently populated`);
        assert.deepEqual(pack.requiredDocTerms, [], `${bucket} must demand no terms`);
        assert.deepEqual(pack.lawQueries, []);
        assert.deepEqual(pack.codeQueries, []);
        assert.equal(pack.minReadPaths, 0);
    }

    // A bucket is not invented by the product either: an unknown one is reported as itself.
    assert.equal(resolveSkillPack({}).bucket, 'general');

    // A consumer that *names* the terms still gets them (`skillPacks` in its own policy — legacy path).
    const declared = resolveSkillPack(
        { bucket: 'root' },
        { skillPacks: { root: { requiredDocTerms: ['their-law'], minReadPaths: 1 } } },
    );
    assert.deepEqual(declared.requiredDocTerms, ['their-law']);
});

test('G-01: the consumer manifest is the pack source, and wins over the legacy policy map', () => {
    const manifest = parseSkillPacks({
        version: 1,
        packs: { backend: { requiredDocTerms: ['mu-bible'], minReadPaths: 1, codeQueries: ['backend/mu-'] } },
    });

    const fromManifest = resolveSkillPack({ bucket: 'backend' }, {}, manifest);
    assert.equal(fromManifest.declared, true);
    assert.deepEqual(fromManifest.requiredDocTerms, ['mu-bible']);
    assert.equal(fromManifest.minReadPaths, 1);

    // Policy and manifest for the same bucket: the manifest's fields win, the rest is inherited.
    const merged = resolveSkillPack(
        { bucket: 'backend' },
        { skillPacks: { backend: { requiredDocTerms: ['old'], lawQueries: ['legacy-law'] } } },
        manifest,
    );
    assert.deepEqual(merged.requiredDocTerms, ['mu-bible'], 'manifest wins for the field it declares');
    assert.deepEqual(merged.lawQueries, ['legacy-law'], 'policy still supplies the field manifest omits');

    // `packName` lets one bucket route to a different declared pack — the "work kind" lever.
    const named = resolveSkillPack({ bucket: 'backend', packName: 'messaging' }, {}, parseSkillPacks({
        messaging: { requiredDocTerms: ['rabbitmq-topology'] },
    }));
    assert.equal(named.bucket, 'messaging');
    assert.deepEqual(named.requiredDocTerms, ['rabbitmq-topology']);
});

test('G-01: a hand-written manifest may omit the version/packs wrapper', () => {
    const bare = parseSkillPacks({ backend: { requiredDocTerms: ['x'] } });
    assert.deepEqual(Object.keys(bare), ['backend']);
    assert.deepEqual(bare.backend.requiredDocTerms, ['x']);

    // Junk in, nothing out — never a throw, never a guess.
    assert.deepEqual(parseSkillPacks(null), {});
    assert.deepEqual(parseSkillPacks('nope'), {});
    assert.deepEqual(parseSkillPacks({ version: 1 }), {});
    // Unknown keys are dropped, so a typo cannot become live data — and an omitted field is *absent*,
    // not defaulted, so it cannot overwrite a legacy policy value during the merge.
    assert.deepEqual(normalisePack({ requiredDocTerm: ['typo'] }), {});
    assert.deepEqual(Object.keys(normalisePack({})), []);
    assert.deepEqual(normalisePack({ lawQueries: ['a', '', 3] }), { lawQueries: ['a'] });
    assert.deepEqual(normalisePack({ minReadPaths: -1 }), { minReadPaths: 0 });
});

test('G-01: an undeclared source is off; a declared one is kept', () => {
    // Nothing declared: law and code are turned off explicitly, because the registry's fallback is
    // "the first capable provider" and an empty block would re-enable them.
    const none = declaredSources({ law: { adapter: 'docgraph-cli', enabled: true } }, { declared: false });
    assert.equal(none.law.enabled, false);
    assert.equal(none.code.enabled, false);

    // The consumer declared its docgraph: keep it.
    const declared = declaredSources(
        { law: { adapter: 'docgraph-cli', enabled: true }, code: { adapter: 'codegraph-cli' } },
        { declared: true },
    );
    assert.equal(declared.law.enabled, true);
    assert.equal(declared.law.adapter, 'docgraph-cli');
    assert.equal(declared.code.enabled, false, 'a provider present without `enabled: true` is not a decision');

    // The ingest caller has no file of its own: it trusts the merged block.
    const merged = declaredSources({ law: { enabled: true } });
    assert.equal(merged.law.enabled, true);
});

test('G-08: a defaulted `enforceWrites` is named as defaulted, and does not change the posture', () => {
    const defaulted = resolveEsoPolicy({ eso: { mode: 'hint' } });
    assert.equal(defaulted.enforceWrites, 'fail_closed', 'the safe default stays (B6)');
    assert.equal(defaulted.enforceWritesDeclared, false);

    const declared = resolveEsoPolicy({ eso: { mode: 'hint', enforceWrites: 'off' } });
    assert.equal(declared.enforceWrites, 'off');
    assert.equal(declared.enforceWritesDeclared, true);

    const verdict = buildTurnVerdict({
        requestId: 'req-g08',
        phase: 'preflight',
        measure: { score: 0.2, level: 'insufficient', lawRatio: 0, readRatio: 0 },
        gaps: [{ kind: 'code', query: 'need at least 1 file read(s); have 0' }],
        eso: defaulted,
        stem: 'refactor the ledger',
    });
    assert.equal(verdict.allowProtectedWrite, false);
    assert.equal(verdict.enforceWritesSource, 'default');
});

test('G-12: the deny names the gap nothing can close and the defaulted lever — not `eso.mode`', () => {
    const text = denyReasonFor({
        level: 'partial',
        score: 0.55,
        enforceWrites: 'fail_closed',
        enforceWritesSource: 'default',
        gaps: [
            { kind: 'law', query: 'harness-tooling', unanswerable: true },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ],
        unanswerableGaps: [{ id: 'law:harness-tooling', reason: 'law adapter returned no rows for this term' }],
    });
    assert.match(text, /cannot be closed by reading this repo/);
    assert.match(text, /law:harness-tooling/);
    assert.match(text, /code:need at least 1 file read/);
    assert.match(text, /enforceWrites.*NOT declared/);
    assert.doesNotMatch(text, /set eso\.mode/);

    // A denial with only a closable gap says how to close it and does not pretend a default is the cause.
    const ordinary = denyReasonFor({
        level: 'insufficient',
        score: 0.2,
        gaps: [{ kind: 'code', query: 'need at least 1 file read(s); have 0' }],
        enforceWritesSource: 'declared',
    });
    assert.match(ordinary, /Close the remaining gaps/);
    assert.doesNotMatch(ordinary, /NOT declared/);
});

test('G-02: a law gap closes on nothing and is named unanswerable', async () => {
    const collected = await runCollect(
        null,
        {
            policy: {},
            eso: ESO,
            surface: { bucket: 'root' },
            stem: 'Đề nghị A rồi B, không chọn C',
            registry,
            // The pack names a term the adapter cannot answer.
            packOverride: undefined,
        },
    );
    // Root pack needs nothing, so a miss cannot even be expressed — prove it with a declaring pack.
    assert.equal(collected.gaps.length, 0);
    assert.deepEqual(collected.lawMisses, []);

    const declaring = await runCollect(
        null,
        {
            policy: { skillPacks: { root: { requiredDocTerms: ['harness-tooling'], lawQueries: ['harness-tooling'] } } },
            eso: ESO,
            surface: { bucket: 'root' },
            stem: 'Đề nghị A rồi B, không chọn C',
            registry,
        },
    );
    assert.deepEqual(declaring.lawMisses, ['harness-tooling']);
    const gap = declaring.gaps.find((g) => g.kind === 'law');
    assert.ok(gap, 'the gap is still reported — R6 forbids removing it');
    assert.equal(gap.unanswerable, true, 'and it is named as one that reading cannot close');
});

test('G-02/G-03: the deny is carried by the closable gaps, not by the unanswerable one', async () => {
    const collected = await runCollect(
        null,
        {
            policy: {
                skillPacks: {
                    root: { requiredDocTerms: ['harness-tooling'], lawQueries: ['harness-tooling'], minReadPaths: 1 },
                },
            },
            eso: ESO,
            surface: { bucket: 'root' },
            stem: 'Đề nghị A rồi B, không chọn C',
            registry,
            reads: { readCount: 1, paths: ['src/app.mjs'] },
        },
    );
    assert.equal(collected.gaps.filter((g) => g.kind === 'law').length, 1);
    assert.equal(collected.gaps.filter((g) => g.kind === 'code').length, 0, 'the read was done');

    // Reading was done; the only remaining gap is the one nothing can close.
    const verdict = buildTurnVerdict({
        requestId: 'req-g03',
        phase: 'preflight',
        measure: collected.measure,
        gaps: collected.gaps,
        eso: ESO,
        stem: 'Đề nghị A rồi B, không chọn C',
    });
    assert.equal(verdict.allowProtectedWrite, true, 'fail_closed must not refuse what it cannot ask for');

    // Control: a closable gap still blocks, exactly as before.
    const blocked = buildTurnVerdict({
        requestId: 'req-g03-blocked',
        phase: 'preflight',
        measure: collected.measure,
        gaps: [...collected.gaps.filter((g) => g.kind !== 'law'), { kind: 'code', query: 'need at least 1 file read(s); have 0' }],
        eso: ESO,
        stem: 'Đề nghị A rồi B, không chọn C',
    });
    assert.equal(blocked.allowProtectedWrite, false);
});

test('G-02: the preflight document names the pack and the gaps nothing can close', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g03-'));
    const projection = buildPreflightProjection(
        { userQueryStem: 'Đề nghị A rồi B', harnessTree: 'cursor', conversationId: 'c1' },
        {
            pack: { bucket: 'root', requiredDocTerms: [] },
            retrieval: { snippets: [], trace: ['docgraph:miss:harness-tooling'], reads: { readCount: 0, paths: [] } },
            gaps: [{ kind: 'law', query: 'harness-tooling', priority: 1, unanswerable: true }],
            measure: { score: 0.45, level: 'partial' },
            verdict: {
                at: new Date().toISOString(),
                level: 'partial',
                score: 0.45,
                allowProtectedWrite: true,
                enforceWrites: 'fail_closed',
                esoMode: 'hint',
                gaps: [{ kind: 'law', query: 'harness-tooling', priority: 1, unanswerable: true }],
            },
        },
        { root },
    );
    assert.deepEqual(projection.lawMisses, ['harness-tooling']);
    assert.deepEqual(projection.unanswerableGaps, [
        { id: 'law:harness-tooling', reason: 'law adapter returned no rows for this term' },
    ]);
    assert.deepEqual(projection.pack, { bucket: 'root', requiredDocTerms: [] });
});

test('G-09: a Brain stamp is not demanded for a gap nothing can close', () => {
    const policy = { eso: { enforceBrain: 'fail_closed' } };
    const view = {
        at: new Date().toISOString(),
        level: 'partial',
        score: 0.45,
        gaps: [{ kind: 'law', query: 'harness-tooling', unanswerable: true }],
    };
    assert.equal(shouldBlockBrain(view, { allClosed: false }, policy), false);
    // A gap that can be closed still demands the record.
    assert.equal(
        shouldBlockBrain(
            { ...view, gaps: [{ kind: 'code', query: 'need at least 1 file read(s); have 0' }] },
            { allClosed: false },
            policy,
        ),
        true,
    );
});

test('G-13: a non-answer is remembered for the repo, and forgotten when the term answers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g13-'));
    assert.deepEqual(readLawMisses(root), {});

    rememberLawMisses(root, ['harness-tooling', 'decision-facade']);
    const first = readLawMisses(root);
    assert.ok(first['harness-tooling'], 'recorded under product state');
    assert.ok(fs.existsSync(path.join(root, '.harness', 'law-misses.json')), 'not in the agent-writable session dir');

    // Next turn: the term answers. It must be forgotten — a stale row would report a non-answer as current.
    rememberLawMisses(root, ['decision-facade'], ['harness-tooling']);
    const second = readLawMisses(root);
    assert.equal(second['harness-tooling'], undefined);
    assert.ok(second['decision-facade']);

    // TTL: an old row is not served.
    const file = path.join(root, '.harness', 'law-misses.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.terms['decision-facade'].missedAt = '2020-01-01T00:00:00Z';
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.deepEqual(readLawMisses(root), {});
});
