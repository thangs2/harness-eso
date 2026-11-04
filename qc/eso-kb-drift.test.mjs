import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    syncDeclarations,
    computeDeclarationHash,
} from '../eso/knowledge/src/index.mjs';

test('SCN-KB-16 (AC-KB-05-01): Matching hashes causes zero changes in database and file (clean sync)', () => {
    const fileDecls = [
        { path: 'skills/docker.md', content: 'version: 1.0\nkind: skill' },
    ];
    const fileHash = computeDeclarationHash(fileDecls[0].content);
    fileDecls[0].content_hash = fileHash;

    const dbDecls = [
        { path: 'skills/docker.md', content_hash: fileHash },
    ];

    const result = syncDeclarations({
        project: 'proj-sync-clean',
        fileDeclarations: fileDecls,
        dbDeclarations: dbDecls,
    });

    assert.equal(result.synced, true);
    assert.equal(result.in, 0);
    assert.equal(result.out, 0);
    assert.deepEqual(result.conflicts, []);
});

test('SCN-KB-17 (AC-KB-05-02): Hash mismatch halts immediately with SYNC_CONFLICT (0 overwrites)', () => {
    const fileDecls = [
        { path: 'rules/auth.md', content_hash: 'hash-disk-aaa', version: '1.0' },
    ];
    const dbDecls = [
        { path: 'rules/auth.md', content_hash: 'hash-db-bbb', version: '1.0' },
    ];

    assert.throws(() => {
        syncDeclarations({
            project: 'proj-sync-conflict',
            fileDeclarations: fileDecls,
            dbDeclarations: dbDecls,
        });
    }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts.length, 1);
        assert.equal(err.conflicts[0].path, 'rules/auth.md');
        assert.equal(err.conflicts[0].file_hash, 'hash-disk-aaa');
        assert.equal(err.conflicts[0].db_hash, 'hash-db-bbb');
        return true;
    });
});

test('SCN-KB-18 (AC-KB-05-03): Re-running sync under conflict STILL halts, never auto-resolves or picks winner', () => {
    const fileDecls = [
        { path: 'skills/db.md', content_hash: 'hash-disk-x1', version: '1.0' },
    ];
    const dbDecls = [
        { path: 'skills/db.md', content_hash: 'hash-db-x2', version: '1.0' },
    ];

    // Attempt 1: halts
    assert.throws(() => {
        syncDeclarations({
            project: 'proj-sync-retry',
            fileDeclarations: fileDecls,
            dbDeclarations: dbDecls,
        });
    }, (err) => err.code === 'SYNC_CONFLICT');

    // Attempt 2: still halts (INV-KB-02: system never auto-picks a winner)
    assert.throws(() => {
        syncDeclarations({
            project: 'proj-sync-retry',
            fileDeclarations: fileDecls,
            dbDeclarations: dbDecls,
        });
    }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts[0].path, 'skills/db.md');
        return true;
    });
});

test('SCN-KB-27 (AC-KB-05-04 & ED1): 0 files on both sides results in clean no-op, 0 writes, 0 errors', () => {
    const result = syncDeclarations({
        project: 'proj-sync-empty',
        fileDeclarations: [],
        dbDeclarations: [],
    });

    assert.equal(result.synced, true);
    assert.equal(result.in, 0);
    assert.equal(result.out, 0);
    assert.deepEqual(result.conflicts, []);
});

test('SCN-KB-28 (AC-KB-05-05 & ED3): Compares 1000 declarations and reports ALL discrepancies without dropping any', () => {
    const fileDecls = [];
    const dbDecls = [];

    for (let i = 0; i < 1000; i++) {
        const path = `skills/item-${i}.md`;
        const fHash = `file-sha-${i}`;
        // Mismatch every 4th item (250 mismatches)
        const dHash = (i % 4 === 0) ? `db-different-sha-${i}` : `file-sha-${i}`;

        fileDecls.push({ path, content_hash: fHash });
        dbDecls.push({ path, content_hash: dHash });
    }

    assert.throws(() => {
        syncDeclarations({
            project: 'proj-sync-bulk',
            fileDeclarations: fileDecls,
            dbDeclarations: dbDecls,
        });
    }, (err) => {
        assert.equal(err.code, 'SYNC_CONFLICT');
        assert.equal(err.conflicts.length, 250);
        return true;
    });
});
