import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildDshBridgePatch,
    renderBundleReadme,
    renderCordisPatchYaml,
} from '../packages/harness-host-dsh/src/index.mjs';
import { writeDshBundle } from '../packages/harness-cli/src/dsh-bridge-cmd.mjs';

test('the patch points the bridge at the consumer hook config', () => {
    const patch = buildDshBridgePatch();
    assert.equal(patch.rows.length, 1);
    assert.equal(patch.rows[0].name, '@deepseek-ai/dsh-hooks-claude-code');
    assert.equal(patch.rows[0].config.configPath, './.claude/settings.json');
    assert.equal(patch.rows[0].config.projectDir, '.');
});

test('the hook config path is pinned, because the bridge reads it against the process cwd', () => {
    // The bridge reads config.path verbatim when the plugin loads; a relative path would resolve
    // against the DSH app directory, not the workspace.
    const pinned = buildDshBridgePatch({ projectDir: '/work/consumer' });
    assert.equal(pinned.rows[0].config.configPath, '/work/consumer/.claude/settings.json');

    const alreadyAbsolute = buildDshBridgePatch({
        configPath: '/work/consumer/.claude/hooks.json',
        projectDir: '/work/consumer',
    });
    assert.equal(alreadyAbsolute.rows[0].config.configPath, '/work/consumer/.claude/hooks.json');

    // Nothing to resolve against: keep the default so a hand-written patch still reads correctly.
    assert.equal(buildDshBridgePatch().rows[0].config.configPath, './.claude/settings.json');

    assert.throws(() => buildDshBridgePatch({ configPath: '' }), /non-empty/);
    assert.throws(() => buildDshBridgePatch({ defaultTimeoutMs: 0 }), /positive integer/);
});

test('the rendered YAML quotes the scoped package name', () => {
    const yaml = renderCordisPatchYaml();
    assert.match(yaml, /^- insert:/m);
    assert.match(yaml, /name: '@deepseek-ai\/dsh-hooks-claude-code'/);
    assert.match(yaml, /configPath: \.\/\.claude\/settings\.json/);
    assert.match(yaml, /defaultTimeoutMs: 120000/);
});

test('the generated bundle is a valid package with the three files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-bundle-'));
    const result = writeDshBundle(dir);
    assert.deepEqual(result.files.sort(), ['README.md', 'cordis.patch.yml', 'package.json']);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    // Without this the inserted row names a package the profile does not have.
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-hooks-claude-code'], '^0.2.1');
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.match(readme, /init profile/);
    assert.match(readme, /host-pack add-ide --profile claude-superset/, 'an existing consumer gets one tree, not a re-provision');

    assert.throws(() => writeDshBundle(dir), /not empty/, 'a non-empty target needs --force');
    writeDshBundle(dir, { force: true });
});

test('the readme names the config path the patch uses', () => {
    assert.match(renderBundleReadme({ configPath: './custom/hooks.json' }), /\.\/custom\/hooks\.json/);
});
