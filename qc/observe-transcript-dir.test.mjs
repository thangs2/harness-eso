import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    consumerRootForCursorSlug,
    cursorProjectSlug,
    cursorTranscriptDirForRoot,
    resolveIngestTranscriptDir,
} from '../packages/harness-observe-server/src/observe-config.mjs';

test('cursorProjectSlug', () => {
    assert.equal(
        cursorProjectSlug('/Users/me/Workspaces/x79'),
        'Users-me-Workspaces-x79',
    );
});

test('resolveIngestTranscriptDir uses HARNESS_CURSOR_MOUNT path when set even if missing', () => {
    const root = '/Users/me/Workspaces/x79';
    const prev = process.env.HARNESS_CURSOR_MOUNT;
    process.env.HARNESS_CURSOR_MOUNT = '/host-cursor';
    try {
        const expected = cursorTranscriptDirForRoot(root, '/host-cursor');
        assert.equal(resolveIngestTranscriptDir(root, {}), expected);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_CURSOR_MOUNT;
        else process.env.HARNESS_CURSOR_MOUNT = prev;
    }
});

test('resolveIngestTranscriptDir prefers HARNESS_CURSOR_MOUNT when present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tx-'));
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cursor-'));
    const slug = cursorProjectSlug(root);
    const dir = path.join(mount, 'projects', slug, 'agent-transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.env.HARNESS_CURSOR_MOUNT;
    process.env.HARNESS_CURSOR_MOUNT = mount;
    try {
        assert.equal(resolveIngestTranscriptDir(root, {}), dir);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_CURSOR_MOUNT;
        else process.env.HARNESS_CURSOR_MOUNT = prev;
    }
});

test('consumerRootForCursorSlug uses HARNESS_REPO_ROOT_HOST in Docker mount layout', () => {
    const prevHost = process.env.HARNESS_REPO_ROOT_HOST;
    process.env.HARNESS_REPO_ROOT_HOST = '/Users/me/Workspaces/x79';
    try {
        assert.equal(consumerRootForCursorSlug('/data/repo'), '/Users/me/Workspaces/x79');
        const dir = cursorTranscriptDirForRoot('/data/repo', '/host-cursor');
        assert.equal(
            dir,
            '/host-cursor/projects/Users-me-Workspaces-x79/agent-transcripts',
        );
    } finally {
        if (prevHost === undefined) delete process.env.HARNESS_REPO_ROOT_HOST;
        else process.env.HARNESS_REPO_ROOT_HOST = prevHost;
    }
});

test('cursorTranscriptDirForRoot matches measure-session-mix default layout', () => {
    const root = '/Users/thangs2net/Workspaces/x79';
    const expected = path.join(
        os.homedir(),
        '.cursor',
        'projects',
        'Users-thangs2net-Workspaces-x79',
        'agent-transcripts',
    );
    assert.equal(cursorTranscriptDirForRoot(root), expected);
});
