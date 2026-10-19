import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    computeFastFingerprint,
    normalizeStem,
    readGitHead,
    readIndexMtime,
} from './fingerprint.mjs';

test('normalizeStem cleans markup and whitespace', () => {
    assert.equal(normalizeStem('<user>  Hello **World**!  </user>'), 'hello world!');
    assert.equal(normalizeStem('   [BUG-123] Fix `auth` issue   '), 'bug-123 fix auth issue');
    assert.equal(normalizeStem(''), '');
    assert.equal(normalizeStem(null), '');
});

test('readGitHead reads symbolic ref or detached hash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
    const gitDir = path.join(tmp, '.git');
    fs.mkdirSync(gitDir, { recursive: true });

    // Test symbolic ref
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    const headsDir = path.join(gitDir, 'refs', 'heads');
    fs.mkdirSync(headsDir, { recursive: true });
    fs.writeFileSync(path.join(headsDir, 'main'), 'abcdef1234567890\n');

    assert.equal(readGitHead(tmp), 'abcdef1234567890');

    // Test detached HEAD
    fs.writeFileSync(path.join(gitDir, 'HEAD'), '11223344556677889900aabbccddeeff\n');
    assert.equal(readGitHead(tmp), '11223344556677889900aabbccddeeff');

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('readIndexMtime returns mtimeMs when .git/index exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-index-'));
    assert.equal(readIndexMtime(tmp), 0);

    const gitDir = path.join(tmp, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'index'), 'dummy index');
    const mtime = readIndexMtime(tmp);
    assert.ok(mtime > 0);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('computeFastFingerprint produces identical hash for same input and varies on change', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fp-'));
    const fp1 = computeFastFingerprint({ stem: 'Implement booking service', root: tmp });
    const fp2 = computeFastFingerprint({ stem: '  implement booking service  ', root: tmp });
    assert.equal(fp1, fp2);

    // Intent drift changes fingerprint
    const fpDrift = computeFastFingerprint({ stem: 'Cancel booking service', root: tmp });
    assert.notEqual(fp1, fpDrift);

    // Git index change changes fingerprint
    const gitDir = path.join(tmp, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'index'), 'initial');
    const fpGit1 = computeFastFingerprint({ stem: 'Implement booking service', root: tmp });
    assert.notEqual(fp1, fpGit1);

    // Touch index
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(gitDir, 'index'), later, later);
    const fpGit2 = computeFastFingerprint({ stem: 'Implement booking service', root: tmp });
    assert.notEqual(fpGit1, fpGit2);

    fs.rmSync(tmp, { recursive: true, force: true });
});
