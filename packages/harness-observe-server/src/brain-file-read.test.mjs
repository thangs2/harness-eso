import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BRAIN_FILE_MAX_BYTES, isWithinRoot, resolveBrainFile } from './brain-file-read.mjs';

/** A throwaway project root, plus a sibling directory that must stay unreachable. */
function sandbox(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-file-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    const write = (rel, body) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
        return full;
    };
    const writeOutside = (name, body) => {
        const full = path.join(outside, name);
        fs.writeFileSync(full, body);
        return full;
    };
    return { base, root, outside, write, writeOutside };
}

test('isWithinRoot is separator-aware — a sibling prefix is not inside', () => {
    assert.equal(isWithinRoot('/a/root', '/a/root/x.md'), true);
    assert.equal(isWithinRoot('/a/root', '/a/root'), true);
    assert.equal(isWithinRoot('/a/root', '/a/root-evil/x.md'), false);
    assert.equal(isWithinRoot('/a/root', '/a/rootx'), false);
});

test('reads a recorded file inside the root', (t) => {
    const { root, write } = sandbox(t);
    const file = write('notes/a.md', '# hello\nworld\n');
    const result = resolveBrainFile({ requestedPath: file, root, allowedPaths: [file] });
    assert.equal(result.ok, true);
    assert.equal(result.text, '# hello\nworld\n');
    assert.equal(result.relativePath, 'notes/a.md');
    assert.equal(result.truncated, false);
});

test('refuses a path that is not a node of the graph', (t) => {
    const { root, write } = sandbox(t);
    write('notes/listed.md', 'x');
    const unlisted = write('notes/secret.md', 'nope');
    const result = resolveBrainFile({ requestedPath: unlisted, root, allowedPaths: [path.join(root, 'notes/listed.md')] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'not_allowed', 403]);
});

test('a recorded path outside the root is still refused', (t) => {
    const { root, writeOutside } = sandbox(t);
    const secret = writeOutside('secret.md', 'classified');
    const result = resolveBrainFile({ requestedPath: secret, root, allowedPaths: [secret] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'outside_root', 403]);
});

test('traversal that resolves outside the root is refused even when recorded', (t) => {
    const { root, write, writeOutside } = sandbox(t);
    write('notes/a.md', 'x');
    writeOutside('secret.md', 'classified');
    const sneaky = path.join(root, 'notes', '..', '..', 'outside', 'secret.md');
    const result = resolveBrainFile({ requestedPath: sneaky, root, allowedPaths: [sneaky] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'outside_root', 403]);
});

test('a symlink that escapes the root is refused', (t) => {
    const { root, outside, write, writeOutside } = sandbox(t);
    void outside;
    write('notes/a.md', 'x');
    const secret = writeOutside('secret.md', 'classified');
    const link = path.join(root, 'notes', 'link.md');
    fs.symlinkSync(secret, link);
    const result = resolveBrainFile({ requestedPath: link, root, allowedPaths: [link] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'outside_root', 403]);
    // The link itself really does point at the outside file (macOS /var is a symlink to /private/var,
    // so compare realpaths rather than the temp path we handed in).
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(outside, 'secret.md')));
});

test('directories and binary files are refused, not streamed', (t) => {
    const { root } = sandbox(t);
    const dir = path.join(root, 'notes');
    const dirResult = resolveBrainFile({ requestedPath: dir, root, allowedPaths: [dir] });
    assert.deepEqual([dirResult.ok, dirResult.code], [false, 'not_a_file']);

    const binary = path.join(root, 'notes', 'blob.md');
    fs.writeFileSync(binary, Buffer.from([0x23, 0x00, 0x41, 0x42]));
    const binaryResult = resolveBrainFile({ requestedPath: binary, root, allowedPaths: [binary] });
    assert.deepEqual([binaryResult.ok, binaryResult.code, binaryResult.status], [false, 'binary', 415]);
});

test('non-text extensions are refused instead of decoded', (t) => {
    const { root, write } = sandbox(t);
    const image = write('notes/logo.png', 'not really a png');
    const result = resolveBrainFile({ requestedPath: image, root, allowedPaths: [image] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'unsupported_type', 415]);

    const dockerfile = write('Dockerfile', 'FROM node:22');
    assert.equal(resolveBrainFile({ requestedPath: dockerfile, root, allowedPaths: [dockerfile] }).ok, true);
});

test('a huge file is truncated at the cap and says so', (t) => {
    const { root, write } = sandbox(t);
    const big = write('notes/big.log', 'x'.repeat(BRAIN_FILE_MAX_BYTES + 50));
    const result = resolveBrainFile({ requestedPath: big, root, allowedPaths: [big], maxBytes: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.shownBytes, 100);
    assert.equal(result.text.length, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, BRAIN_FILE_MAX_BYTES + 50);
});

test('malformed paths are rejected before touching the filesystem', (t) => {
    const { root } = sandbox(t);
    for (const bad of ['', 'x'.repeat(5000), `/tmp/a\u0000b`, null, 42]) {
        const result = resolveBrainFile({ requestedPath: bad, root, allowedPaths: [] });
        assert.deepEqual([result.ok, result.code, result.status], [false, 'invalid_path', 400]);
    }
});

test('a missing file is a 404, not a crash', (t) => {
    const { root } = sandbox(t);
    const gone = path.join(root, 'notes', 'gone.md');
    const result = resolveBrainFile({ requestedPath: gone, root, allowedPaths: [gone] });
    assert.deepEqual([result.ok, result.code, result.status], [false, 'missing', 404]);
});
