import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { checkDocgraphFreshness, isCovered, parseScope } = await import(
    path.join(REPO, 'scripts', 'check-docgraph.mjs')
);

function repo({ scope = 'ext:.md\next:.mdc\npath:documents\nexclude:documents/archive/**\n', files = {}, index } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docgraph-freshness-'));
    fs.writeFileSync(path.join(root, 'docgraph.scope'), scope);
    for (const [rel, body] of Object.entries(files)) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    if (index !== undefined) {
        fs.mkdirSync(path.join(root, '.docgraph'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.docgraph', 'docgraph.json'),
            typeof index === 'string' ? index : JSON.stringify(index),
        );
    }
    return root;
}

/** An index that is newer than every file written above, with the entries the caller names. */
function indexAt(iso, entries) {
    return { schema_version: 1, generated_at: iso, entries: entries.map((p) => ({ p })) };
}

test('G-20: a covered document written after the index was built makes it stale', () => {
    /*
     * The real incident. The index was built 2026-10-14; `06.concept-mission-vision.md` and the two
     * `05.development` registers were written days later. Every `docgraph --q` in those turns
     * searched a corpus that did not contain them, and the "docgraph first" rule was silently
     * false. Nothing failed — this is the probe that makes that state visible.
     */
    const root = repo({ files: { 'documents/new.md': '# new' }, index: indexAt('2026-10-14T00:00:00Z', []) });
    const report = checkDocgraphFreshness(root);
    assert.equal(report.status, 'stale');
    assert.deepEqual(report.newer, ['documents/new.md']);
    assert.match(report.detail, /built 2026-10-14/);
});

test('G-20: an index newer than everything it covers is current', () => {
    const root = repo({
        files: { 'documents/a.md': '# a', 'documents/b.mdc': '# b' },
        index: indexAt('2030-01-01T00:00:00Z', ['documents/a.md', 'documents/b.mdc']),
    });
    const report = checkDocgraphFreshness(root);
    assert.equal(report.status, 'current');
    assert.deepEqual(report.newer, []);
    assert.deepEqual(report.missing, []);
});

test('G-20: the scope is an allowlist, so files outside its `path:` roots are not missing', () => {
    /* `comments/artifacts/**` is .md and on disk, but not in scope — reporting it would be noise. */
    const root = repo({
        files: { 'documents/a.md': '# a', 'comments/artifacts/note.md': '# note', 'outside.md': '# x' },
        index: indexAt('2030-01-01T00:00:00Z', ['documents/a.md']),
    });
    const report = checkDocgraphFreshness(root);
    assert.equal(report.status, 'current');
});

test('G-20: `exclude:` patterns keep a directory out of the comparison', () => {
    const scope = parseScope('ext:.md\npath:documents\nexclude:documents/archive/**\n');
    assert.equal(isCovered('documents/a.md', scope), true);
    assert.equal(isCovered('documents/archive/old.md', scope), false);
    assert.equal(isCovered('documents/a.txt', scope), false, 'an extension outside `ext:` is not covered');
    assert.equal(isCovered('outside/a.md', scope), false, 'an entry needs a `path:` root');
});

test('G-20: an index that disagrees with the scope in either direction is reported as out-of-step', () => {
    const root = repo({
        files: { 'documents/a.md': '# a' },
        index: indexAt('2030-01-01T00:00:00Z', ['documents/a.md', 'documents/deleted.md']),
    });
    const report = checkDocgraphFreshness(root);
    assert.equal(report.status, 'out-of-step');
    assert.deepEqual(report.extra, ['documents/deleted.md']);
    assert.deepEqual(report.missing, []);
});

test('G-20: a missing or unreadable index is `absent`, not `current`', () => {
    assert.equal(checkDocgraphFreshness(repo({ files: { 'documents/a.md': '# a' } })).status, 'absent');
    assert.equal(checkDocgraphFreshness(repo({ index: 'not json' })).status, 'absent');
    assert.equal(checkDocgraphFreshness(repo({ index: { schema_version: 1, entries: [] } })).status, 'absent');
});

test('G-20: a repo with no `docgraph.scope` is `absent` rather than an empty pass', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docgraph-noscope-'));
    assert.equal(checkDocgraphFreshness(root).status, 'absent');
});

test('G-20: the repo this product ships has a current docgraph index', () => {
    /*
     * Not a tautology: this is the check that would have failed on 2026-10-23. It reads the real
     * `.docgraph/docgraph.json` against the real `docgraph.scope`, so forgetting `docgraph build`
     * after editing a document while running the suite is a red test, not a silent rule.
     */
    const { status, newer, detail } = checkDocgraphFreshness(REPO);
    assert.notEqual(status, 'stale', `docgraph index is older than its content (${detail}) — run: docgraph build`);
    void newer;
});

test('the CLI exits non-zero on a stale index so a pre-commit hook can use it', () => {
    const root = repo({ files: { 'documents/new.md': '# new' }, index: indexAt('2026-10-14T00:00:00Z', []) });
    let code = 0;
    try {
        execFileSync(process.execPath, [path.join(REPO, 'scripts', 'check-docgraph.mjs'), '--json'], {
            env: { ...process.env, DOCGRAPH_REPO: root },
            stdio: 'pipe',
        });
    } catch (err) {
        code = err.status;
    }
    assert.equal(code, 1);
});
