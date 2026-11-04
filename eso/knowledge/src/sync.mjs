/**
 * @mu/eso-knowledge — Declaration File & DB Drift Sync (ESO-140 / US-KB-05 / Slice S1)
 *
 * Implements:
 * - AC-KB-05-01: Matching hashes -> no changes, clean sync (0 writes).
 * - AC-KB-05-02: Hash mismatch -> HALTS, reports file + both hashes with SYNC_CONFLICT.
 * - AC-KB-05-03: Retrying on conflict STILL halts, never auto-resolves or picks a winner (INV-KB-02).
 * - AC-KB-05-04: 0 files on both sides -> no-op with 0 writes, 0 errors.
 * - AC-KB-05-05: Compares all files, reports all discrepancies without dropping any.
 * - D-23: Cùng hash nội dung => không xung đột; lệch => DỪNG.
 * - BR-06: 0 writes on conflict; phase 2 does not open when conflicts > 0.
 */

import { createHash } from 'node:crypto';

export function computeDeclarationHash(content) {
    if (typeof content !== 'string') {
        content = JSON.stringify(content || '');
    }
    // Normalize line endings to avoid false drift across platforms (CRLF -> LF)
    const normalized = content.replace(/\r\n/g, '\n').trim();
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function syncDeclarations({
    project,
    fileDeclarations = [],
    dbDeclarations = [],
    options = {},
} = {}) {
    if (!project || typeof project !== 'string') {
        throw new Error('Project identifier is required');
    }

    // AC-KB-05-04 / ED1: 0 files on both sides -> clean no-op
    if (fileDeclarations.length === 0 && dbDeclarations.length === 0) {
        return {
            synced: true,
            in: 0,
            out: 0,
            conflicts: [],
        };
    }

    // Phase 1: Full comparison across all declarations (AC-KB-05-05)
    const fileMap = new Map();
    for (const fd of fileDeclarations) {
        const path = fd.path || fd.file || fd.id;
        fileMap.set(path, fd);
    }

    const dbMap = new Map();
    for (const dd of dbDeclarations) {
        const path = dd.path || dd.file || dd.id;
        dbMap.set(path, dd);
    }

    const allPaths = new Set([...fileMap.keys(), ...dbMap.keys()]);
    const conflicts = [];

    for (const path of allPaths) {
        const fileItem = fileMap.get(path);
        const dbItem = dbMap.get(path);

        if (fileItem && dbItem) {
            const fileHash = fileItem.content_hash || computeDeclarationHash(fileItem.content || fileItem);
            const dbHash = dbItem.content_hash || computeDeclarationHash(dbItem.content || dbItem);

            if (fileHash !== dbHash) {
                conflicts.push({
                    path,
                    file_hash: fileHash,
                    db_hash: dbHash,
                    reason: 'hash_mismatch',
                    file_version: fileItem.version,
                    db_version: dbItem.version,
                });
            }
        }
    }

    // Phase 2: Halt if conflicts exist (AC-KB-05-02, AC-KB-05-03)
    if (conflicts.length > 0) {
        // Zero writes: phase 2 is aborted, 0 modifications
        const err = new Error(`SYNC_CONFLICT: Detected ${conflicts.length} conflict(s) between filesystem and database. Human resolution required (INV-KB-02).`);
        err.code = 'SYNC_CONFLICT';
        err.conflicts = conflicts;
        throw err;
    }

    // Matching hashes or clean sync
    return {
        synced: true,
        in: 0,
        out: 0,
        conflicts: [],
    };
}
