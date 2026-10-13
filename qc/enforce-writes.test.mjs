import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    DEFAULT_ESO_POLICY,
    ENFORCE_WRITES_VALUES,
    resolveEnforceWrites,
    resolveEsoPolicy,
} from '../packages/harness-eso-core/src/eso-policy.mjs';
import { buildTurnVerdict } from '../packages/harness-eso-core/src/gate.mjs';

/**
 * F24 — `enforceWrites` had one valid set, one dead branch, two implementations and no diagnostics.
 *
 * The rule collapsed to "`off`, or else enforce", because both the `mode === 'fail_closed'` branch and
 * the fallback resolved to `fail_closed`. So `observe` — which is a valid **`eso.mode`** and therefore
 * looks like a valid setting — silently produced the strictest posture instead of the most permissive
 * one, and `gate.mjs` re-derived the same answer with a different fallback.
 *
 * These tests pin three things: the valid set, the posture (unchanged, deliberately conservative), and
 * the fact that the two modules now agree for *any* input rather than only for normalised input.
 */

const measure = (level, score = 0.5) => ({ level, score });

function verdictFor(eso) {
    return buildTurnVerdict({
        requestId: 'f24',
        phase: 'preflight',
        measure: measure('insufficient'),
        gaps: [],
        eso,
        stem: 'x',
    });
}

test('the valid set is exactly fail_closed and off', () => {
    assert.deepEqual(ENFORCE_WRITES_VALUES, ['fail_closed', 'off']);
    // `observe` is a valid MODE and deliberately not a valid enforceWrites value.
    assert.ok(!ENFORCE_WRITES_VALUES.includes('observe'));
});

test('explicit valid values pass through unchanged', () => {
    assert.equal(resolveEnforceWrites({ enforceWrites: 'fail_closed' }), 'fail_closed');
    assert.equal(resolveEnforceWrites({ enforceWrites: 'off' }), 'off');
    // An explicit value wins over mode, as it always did.
    assert.equal(resolveEnforceWrites({ enforceWrites: 'off', mode: 'fail_closed' }), 'off');
    assert.equal(resolveEnforceWrites({ enforceWrites: 'fail_closed', mode: 'hint' }), 'fail_closed');
});

test('absent resolves to the documented conservative default', () => {
    assert.equal(resolveEnforceWrites({}), DEFAULT_ESO_POLICY.enforceWrites);
    assert.equal(resolveEnforceWrites({ enforceWrites: '' }), DEFAULT_ESO_POLICY.enforceWrites);
    assert.equal(resolveEnforceWrites({ enforceWrites: null }), DEFAULT_ESO_POLICY.enforceWrites);
    assert.equal(resolveEnforceWrites(undefined), DEFAULT_ESO_POLICY.enforceWrites);
});

test('an invalid value resolves conservatively, not silently loosening', () => {
    // The posture is deliberately unchanged: an ambiguous config must not make a guard weaker than
    // the operator asked for. What changed is that it is now reported.
    for (const bad of ['observe', 'fail_clsoed', true, 0, 'FAIL_CLOSED', {}]) {
        assert.equal(
            resolveEnforceWrites({ enforceWrites: bad }),
            DEFAULT_ESO_POLICY.enforceWrites,
            `${JSON.stringify(bad)} must not loosen the gate`,
        );
    }
});

test('an invalid value is reported on stderr, once per process, with the fix', () => {
    // Run in a child so the once-per-process guard starts clean and stdout/stderr can be separated.
    const script = `
        import { resolveEnforceWrites } from '${new URL('../packages/harness-eso-core/src/eso-policy.mjs', import.meta.url).pathname}';
        resolveEnforceWrites({ enforceWrites: 'observe' });
        resolveEnforceWrites({ enforceWrites: 'observe' });
        process.stdout.write('RESULT=' + resolveEnforceWrites({ enforceWrites: 'observe' }) + '\\n');
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    // Reported, and reported once — a per-turn warning would be noise.
    const hits = (r.stderr.match(/not valid/g) || []).length;
    assert.equal(hits, 1, `expected exactly one warning, got ${hits}: ${r.stderr}`);
    assert.match(r.stderr, /"observe"/);
    assert.match(r.stderr, /"fail_closed" or "off"/);
    assert.match(r.stderr, /write "off"/, 'must name the likely intent');
    // stdout stays clean: the host reads it as the hook verdict.
    assert.equal(r.stdout.trim(), 'RESULT=fail_closed');
    assert.ok(!r.stdout.includes('not valid'), 'diagnostics must never go to stdout');
});

test('policy and gate agree for every input, normalised or not', () => {
    // The divergence: `gate.mjs` had fallback `'off'`, `eso-policy.mjs` had `fail_closed`. They agreed
    // only because `orchestrateTurn` always passes a resolved policy — so nothing caught it.
    const inputs = [
        {},
        { mode: 'hint' },
        { mode: 'fail_closed' },
        { enforceWrites: 'off' },
        { enforceWrites: 'fail_closed' },
        { enforceWrites: 'observe', mode: 'hint' },
        { enforceWrites: 'fail_clsoed', mode: 'fail_closed' },
        { enforceWrites: true },
        { enforceWrites: null, mode: 'observe' },
    ];
    for (const eso of inputs) {
        const viaPolicy = resolveEsoPolicy({ eso }).enforceWrites;
        const viaGate = verdictFor(eso).enforceWrites;
        assert.equal(
            viaGate,
            viaPolicy,
            `gate and policy disagree for ${JSON.stringify(eso)}: ${viaGate} vs ${viaPolicy}`,
        );
        const viaShared = resolveEnforceWrites(eso);
        assert.equal(viaGate, viaShared);
    }
});

test('an explicit off really does disable the gate', () => {
    // The one escape hatch must keep working: this is what an operator writes when they want the ESO
    // write gate out of the way.
    const v = verdictFor({ mode: 'hint', enforceWrites: 'off' });
    assert.equal(v.enforceWrites, 'off');
    assert.equal(verdictFor({ mode: 'hint', enforceWrites: 'fail_closed' }).enforceWrites, 'fail_closed');
});
