import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDshPlugin, ROW_ID, ROW_NAME } from '../scripts/build-dsh-plugin.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/harness-eso-dsh');

test('the package is installable as a bundle with no dependencies to hoist', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.exports['./plugin'], './dist/eso-plugin.mjs');
    // The whole point: nothing for pnpm to install, so no second instance of an app-shipped package.
    assert.equal(manifest.dependencies, undefined);
});

test('the build produces one file that imports only node builtins', async () => {
    const { manifest, bytes } = await buildDshPlugin();
    assert.deepEqual(manifest.externalImports, []);
    assert.ok(bytes > 5_000, `bundle looks too small: ${bytes} bytes`);

    const source = fs.readFileSync(path.join(PKG, 'dist/eso-plugin.mjs'), 'utf8');
    const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
        assert.ok(specifier.startsWith('node:'), `unexpected import: ${specifier}`);
    }
});

test('the generated patch inserts exactly one row, and it points at this package', () => {
    const patch = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /^- insert:/m);
    assert.match(patch, new RegExp(`id: ${ROW_ID}\\b`));
    assert.equal(patch.split('id:').length - 1, 1, 'one row only: a duplicate id mounts the plugin twice');
    assert.match(patch, new RegExp(`name: '${ROW_NAME.replace(/[/@.]/g, (c) => `\\${c}`)}'`));
});

test('the bundle exports the plugin shape DSH loads', async () => {
    await buildDshPlugin();
    const mod = await import(path.join(PKG, 'dist/eso-plugin.mjs'));
    const plugin = mod.default ?? mod;
    assert.equal(plugin.name, 'harness-eso');
    assert.deepEqual(plugin.inject, []);
    assert.equal(typeof plugin.apply, 'function');
});
