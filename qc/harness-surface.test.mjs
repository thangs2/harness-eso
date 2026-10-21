import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    checkHarnessSurface,
    DEFAULT_ALWAYS_ON_CAP,
    globToRegExp,
    normalizeSurfaceRel,
    readHarnessSurface,
} from '../packages/harness-eso-core/src/surface-check.mjs';

function workspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-surface-'));
}

function write(root, rel, body) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
}

test('globs are anchored and treat ** as any depth', () => {
    assert.equal(globToRegExp('AGENTS.md').test('AGENTS.md'), true);
    assert.equal(globToRegExp('AGENTS.md').test('x/AGENTS.md'), false);
    assert.equal(globToRegExp('.agents/skills/**').test('.agents/skills/a/SKILL.md'), true);
    assert.equal(globToRegExp('**/hooks.json').test('.codex/hooks.json'), true);
    assert.equal(globToRegExp('**/hooks.json').test('hooks.json'), true);
    assert.equal(globToRegExp('*.md').test('a/b.md'), false);
    assert.equal(globToRegExp('?.md').test('a.md'), true);
});

test('a declared path can never escape the root', () => {
    assert.deepEqual(normalizeSurfaceRel('./AGENTS.md'), { rel: 'AGENTS.md' });
    assert.equal(normalizeSurfaceRel('../secret.md').error, 'path escapes the root');
    assert.equal(normalizeSurfaceRel('/etc/passwd').error, 'absolute path');
    assert.equal(normalizeSurfaceRel('C:/x').error, 'absolute path');
});

test('no declaration means skip, never a verdict', () => {
    const report = checkHarnessSurface(workspace(), null);
    assert.equal(report.status, 'skip');
    assert.equal(report.violations.length, 0);
});

test('an editable glob that matches the hook config fails as gate-in-editable-surface', () => {
    const root = workspace();
    write(root, '.codex/hooks.json', '{"hooks":{}}');
    const report = checkHarnessSurface(root, {
        surfaces: [{ id: 'codex', editable: ['AGENTS.md', '.codex/hooks.json'] }],
    });
    assert.equal(report.status, 'fail');
    assert.equal(report.violations[0].kind, 'gate-in-editable-surface');
    assert.match(report.detail, /could delete or rewrite the guard \(B2\)/);
});

test('a wildcard that happens to cover the hook config also fails', () => {
    const root = workspace();
    write(root, '.codex/hooks.json', '{"hooks":{}}');
    const report = checkHarnessSurface(root, { surfaces: [{ id: 'codex', editable: ['**'] }] });
    assert.equal(report.status, 'fail');
    assert.equal(report.violations[0].kind, 'gate-in-editable-surface');
});

test('hooks outside the editable set pass, and the preset supplies hooksFile', () => {
    const root = workspace();
    write(root, '.codex/hooks.json', '{"hooks":{}}');
    write(root, 'AGENTS.md', '# rules\n');
    const report = checkHarnessSurface(root, {
        surfaces: [{ id: 'codex', editable: ['AGENTS.md', '.agents/skills/**'] }],
    });
    assert.equal(report.status, 'pass');
    assert.equal(report.surfaces[0].hooksFile, '.codex/hooks.json');
    assert.equal(report.surfaces[0].alwaysOnTokens, 3);
});

test('always-on over the cap fails instead of being trusted', () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'x'.repeat(400));
    const report = checkHarnessSurface(root, {
        alwaysOnMaxTokens: 10,
        surfaces: [{ id: 'codex', editable: [] }],
    });
    assert.equal(report.status, 'fail');
    assert.equal(report.violations[0].kind, 'always-on-over-budget');
    assert.match(report.detail, /competes? with the output budget/);
});

test('the default cap is 8000 and an always-on directory is summed', () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'x'.repeat(38));
    write(root, 'docs/a.md', 'x'.repeat(38));
    const report = checkHarnessSurface(root, {
        surfaces: [{ id: 'agents', alwaysOn: ['AGENTS.md', 'docs'], editable: [] }],
    });
    assert.equal(report.cap, DEFAULT_ALWAYS_ON_CAP);
    assert.equal(report.status, 'pass');
    assert.equal(report.surfaces[0].alwaysOnTokens, 20);
});

test('an escaping glob is a surface error, not a silent no-op', () => {
    const root = workspace();
    const report = checkHarnessSurface(root, { surfaces: [{ id: 'codex', editable: ['../secrets'] }] });
    assert.equal(report.status, 'fail');
    assert.equal(report.violations[0].kind, 'invalid-surface');
});

test('the declaration is read from harness.config.json and a broken one is null', () => {
    const root = workspace();
    write(
        root,
        'harness.config.json',
        JSON.stringify({ harnessSurface: { surfaces: [{ id: 'codex', editable: ['AGENTS.md'] }] } }),
    );
    assert.equal(readHarnessSurface(root).surfaces[0].id, 'codex');

    write(root, 'harness.config.json', '{not json');
    assert.equal(readHarnessSurface(root), null);
});
