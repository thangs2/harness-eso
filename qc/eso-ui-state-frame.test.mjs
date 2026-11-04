import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(REPO_ROOT, 'eso/ui/apps/control-plane/src/app');
const FRAME = join(APP, 'shared/state-frame/state-frame.component.ts');

/**
 * No Angular test runner is installed in this workspace, so the component
 * contract is asserted against the component source. Each assertion below fails
 * if the corresponding branch or copy disappears.
 */
test('Angular state frame: ST6 is stale only and READY is the content state', () => {
    const source = readFileSync(FRAME, 'utf-8');
    const union = source.match(/export type UXState =([\s\S]*?);/)[1];
    const states = [...union.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);

    assert.deepEqual(states, [
        'ST1_EMPTY',
        'ST2_LOADING',
        'ST3_FAILED',
        'ST4_DENIED',
        'ST5_PARTIAL',
        'ST6_STALE',
        'READY',
    ]);
    assert.equal(states.includes('ST6_READY'), false, 'a ready surface must not be an ST6 state');
});

test('Angular state frame: every state that AC-UI-01 names has a branch', () => {
    const source = readFileSync(FRAME, 'utf-8');
    for (const state of ['ST2_LOADING', 'ST3_FAILED', 'ST4_DENIED', 'ST1_EMPTY', 'ST5_PARTIAL', 'ST6_STALE']) {
        assert.match(source, new RegExp(`@case \\('${state}'\\)`), `${state} must have a template branch`);
    }
    assert.match(source, /frame-ready/, 'READY must render the content branch');
});

test('Angular state frame: denied never renders the empty copy', () => {
    const source = readFileSync(FRAME, 'utf-8');
    const deniedBlock = source.match(/@case \('ST4_DENIED'\) \{[\s\S]*?\n {16}\}/)[0];

    assert.match(deniedBlock, /frame-denied/);
    assert.match(deniedBlock, /Truy cập bị từ chối hoặc tài nguyên không tìm thấy\./);
    assert.equal(deniedBlock.includes('emptyMessage()'), false, 'denied must not reuse the ST1 sentence');
});

test('Angular state frame: counts and coverage are data, never fixture defaults', () => {
    const source = readFileSync(FRAME, 'utf-8');

    assert.match(source, /input<number \| null>\(null\)/, 'missingCount/coverage default to null');
    assert.equal(/input<number>\(0\)/.test(source), false);
    assert.equal(/input<number>\(1\.0\)/.test(source), false);
    assert.equal(/\b0\.62\b/.test(source), false, 'fixture ratio 0.62 must not live in product code');
    // ST6 must show the ratio when it is recorded…
    assert.match(source, /Graph phủ \$\{coverage\}/);
    // …and must not claim one when it is not.
    assert.match(source, /coverage === null/);
});

test('Angular app: no surface sends ST6_READY — content pages send READY', () => {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (full.endsWith('.ts')) {
                const source = readFileSync(full, 'utf-8');
                if (/'ST6_READY'/.test(source)) offenders.push(full.replace(REPO_ROOT + '/', ''));
            }
        }
    };
    walk(APP);

    assert.deepEqual(offenders, [], `ready surfaces must send 'READY', not 'ST6_READY': ${offenders.join(', ')}`);
});
