import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    checkDshProfiles,
    dshHome,
    SYMBOL_BEARING_PACKAGES,
} from '../packages/harness-host-dsh/src/profile-doctor.mjs';

function home(profile = 'desktop', manifest = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
    const dir = path.join(root, 'profiles', profile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
            name: `dsh-profile-${profile}`,
            private: true,
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
            ...manifest,
        }),
    );
    return { root, dir };
}

test('the contract-bearing list matches the packages ATF-OPS-001 names', () => {
    for (const name of [
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-agent-loop',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-session',
    ]) {
        assert.ok(SYMBOL_BEARING_PACKAGES.includes(name), `${name} must be symbol-bearing`);
    }
    assert.equal(SYMBOL_BEARING_PACKAGES.includes('@deepseek-ai/dsh-hooks-claude-code'), false);
});

test('a profile that declares nothing is healthy — the app ships those packages once', () => {
    const { root } = home();
    const report = checkDshProfiles({ home: root, profile: 'desktop' });
    assert.equal(report.verdict, 'healthy');
    assert.deepEqual(
        report.profiles[0].checks.map((c) => c.status),
        ['pass', 'pass', 'pass'],
    );
});

test('declaring a symbol-bearing package is a pathology, named before the app boots', () => {
    const { root } = home('desktop', { dependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.2' } });
    const report = checkDshProfiles({ home: root });
    assert.equal(report.verdict, 'pathology-present');
    const check = report.profiles[0].checks.find((c) => c.id === 'P1.declared');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /dsh-tools/);
    assert.match(check.detail, /Symbol identity/);
});

test('a copy on disk is enough, even when the manifest no longer declares it', () => {
    const { root, dir } = home();
    const pkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm' }));

    const report = checkDshProfiles({ home: root });
    const check = report.profiles[0].checks.find((c) => c.id === 'P2.node_modules');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /dsh-llm/);
});

test('the same mount id in the user patch and a bundle patch is a warning', () => {
    const { root, dir } = home();
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- id: harness-eso-hooks\n  name: x\n');
    const bundle = path.join(dir, 'node_modules', 'some-bundle');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: harness-eso-hooks\n      name: y\n');

    const report = checkDshProfiles({ home: root });
    assert.equal(report.verdict, 'unverified');
    const check = report.profiles[0].checks.find((c) => c.id === 'P3.patch-ids');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /harness-eso-hooks/);
});

test('a broken manifest is unverified, never healthy by default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-bad-'));
    const dir = path.join(root, 'profiles', 'desktop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{not json');
    const report = checkDshProfiles({ home: root });
    assert.equal(report.verdict, 'unverified');
});

test('DSH_HOME wins over the default, as it does for the app', () => {
    assert.equal(dshHome({ DSH_HOME: '/tmp/elsewhere' }), '/tmp/elsewhere');
    assert.match(dshHome({}), /\.dsh$/);
});
