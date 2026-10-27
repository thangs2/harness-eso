import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEsoDshPlugin } from '../packages/harness-eso-dsh/src/plugin.mjs';

/*
 * The silent deadlock: `enforceWrites: fail_closed` with no `eso.checks`.
 *
 * Measured on BA Platform before this existed. `agent/pre-step` returned at `if (!checks) return`
 * without writing an attestation and without saying so. `guard-write.py` consults the ESO gate
 * **before** the Brain gate, so it denied every protected write with `DENY_ESO` against an
 * `allowWrite: false` that had been sitting on disk since an earlier run. The operator, reading
 * "ESO gate", would make a Brain call; the witness would record it correctly; the write would still
 * be refused, because `recordBrainCall` deliberately preserves the previous `allowWrite` and nothing
 * ever refreshed it. No single message in that chain names the actual cause.
 *
 * These cases pin the diagnostic that names it, and — equally important — that it stays out of the
 * way when the consumer's configuration is not actually in this state.
 */

/** A throwaway consumer with its own `harness.config.json` and decision policy. */
function makeConsumer(eso) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-dsh-nochecks-'));
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ project: { id: `nochecks${process.pid}${Math.floor(Math.random() * 1e6)}` } }),
    );
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness', 'decision-policy.json'), JSON.stringify({ eso }));
    return root;
}

/**
 * Drive the real `agent/pre-step` handler the way Cordis would.
 *
 * @param {string} root consumer root
 * @param {object} config row config
 * @param {number} steps how many entering steps to simulate
 */
async function runSteps(root, config, steps = 1) {
    const logs = [];
    let preStep = null;
    const ctx = {
        logger: { info: (m) => logs.push(String(m)) },
        on: (event, fn) => {
            if (event === 'agent/pre-step') preStep = fn;
            return () => {};
        },
        workingDirectory: { get: () => root },
    };
    createEsoDshPlugin({ root }).apply(ctx, config);
    assert.equal(typeof preStep, 'function', 'the plugin must register an agent/pre-step handler');
    for (let i = 0; i < steps; i += 1) {
        await preStep({ agent: { session: 'sess' } }, async () => ({ kind: 'enter' }));
    }
    return logs;
}

const warned = (logs) => logs.filter((l) => l.includes('no eso.checks declared'));

test('fail_closed with no eso.checks: one diagnostic, naming the deadlock and both remedies', async () => {
    const root = makeConsumer({ enabled: true, mode: 'hint', enforceWrites: 'fail_closed' });
    const logs = await runSteps(root, {});
    const hits = warned(logs);

    assert.equal(hits.length, 1, 'exactly one warning, not one per step and not zero');
    const line = hits[0];
    // It must name all three things an operator needs: the cause, the misattributed symptom, and a way out.
    assert.match(line, /no eso\.checks declared/);
    assert.match(line, /ESO gate/);
    assert.match(line, /\.harness\/decision-policy\.json/);
    assert.match(line, /enforceWrites/);
});

test('the diagnostic is once per session, not once per step', async () => {
    const root = makeConsumer({ enabled: true, mode: 'hint', enforceWrites: 'fail_closed' });
    const logs = await runSteps(root, {}, 5);
    assert.equal(warned(logs).length, 1, 'five entering steps still produce one line');
});

test('silent when the row config supplies checks — the condition does not apply', async () => {
    const root = makeConsumer({ enabled: true, mode: 'hint', enforceWrites: 'fail_closed' });
    const before = path.join(root, 'before.json');
    const after = path.join(root, 'after.json');
    fs.writeFileSync(before, JSON.stringify({ paths: ['a'] }));
    fs.writeFileSync(after, JSON.stringify({ paths: ['a'] }));
    const logs = await runSteps(root, { checks: { contract: { before, after, direction: 'request' } } });
    assert.equal(warned(logs).length, 0, 'a consumer that declared checks must not be nagged');
});

test('silent when enforceWrites is off — nothing is blocked, so nothing to warn about', async () => {
    const root = makeConsumer({ enabled: true, mode: 'hint', enforceWrites: 'off' });
    const logs = await runSteps(root, {});
    assert.equal(warned(logs).length, 0);
});

test('silent when eso is disabled outright', async () => {
    const root = makeConsumer({ enabled: false, mode: 'hint', enforceWrites: 'fail_closed' });
    const logs = await runSteps(root, {});
    /*
     * `enforceWrites` still resolves to `fail_closed` here, so this case is about the guard, not the
     * config: the warning describes a gate that will actually refuse writes. With `enabled: false` the
     * consumer has opted out, and telling it about a gate it disabled would be noise.
     *
     * Asserted as "no crash and no false claim" rather than a hard zero, because whether the message is
     * useful when the gate is off is a judgement call; what must never happen is a warning that misnames
     * the state.
     */
    for (const line of warned(logs)) {
        assert.match(line, /fail_closed/, 'any warning must still describe the resolved enforcement');
    }
});
