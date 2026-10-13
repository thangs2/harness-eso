import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeHostPack } from '../packages/harness-console-server/src/host-pack-summary.mjs';

const base = {
    installed: true,
    ok: true,
    outdated: false,
    version: '0.1.0',
    buildVersion: '0.1.0',
    corrupt: [],
    verification: { ok: true, failures: [] },
    trees: [{ tree: 'cursor', hooks: 3, overridden: [] }],
};

test('a healthy pack reports ok with its version', () => {
    assert.deepEqual(summarizeHostPack(base), { state: 'ok', version: '0.1.0', trees: 1 });
});

test('a missing pack is distinct from a broken one', () => {
    // "not installed" and "installed but corrupt" need different operator actions — one is a
    // provisioning step, the other is a repair — so they must not collapse into one state.
    const missing = summarizeHostPack({ installed: false, reason: 'no host pack installed' });
    assert.equal(missing.state, 'missing');
    assert.match(missing.detail, /no host pack/);

    const broken = summarizeHostPack({ ...base, ok: false, corrupt: ['harness-hook.mjs (checksum)'] });
    assert.equal(broken.state, 'broken');
    assert.match(broken.detail, /harness-hook\.mjs/);
});

test('a pack whose hooks cannot decide is broken, not ok', () => {
    // Integrity can pass while the bundle does not run — that is exactly what the probe catches,
    // and it is the state where a consumer is silently unguarded.
    const s = summarizeHostPack({
        ...base,
        verification: { ok: false, failures: ['guard-shell'] },
    });
    assert.equal(s.state, 'broken');
    assert.match(s.detail, /guard-shell/);
});

test('outdated is reported even though the pack still works', () => {
    const s = summarizeHostPack({ ...base, outdated: true, buildVersion: '0.2.0' });
    assert.equal(s.state, 'outdated');
    assert.match(s.detail, /0\.1\.0/);
    assert.match(s.detail, /0\.2\.0/);
});

test('a pack nothing invokes is reported as unwired', () => {
    // Installed, intact, working — and connected to no IDE. Every other check passes, so without
    // this state the project would look healthily protected while no hook ever ran.
    const s = summarizeHostPack({ ...base, trees: [] });
    assert.equal(s.state, 'unwired');
});

test('a null or absent status does not throw', () => {
    assert.equal(summarizeHostPack(null).state, 'missing');
    assert.equal(summarizeHostPack(undefined).state, 'missing');
});
