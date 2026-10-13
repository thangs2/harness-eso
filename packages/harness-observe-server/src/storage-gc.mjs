import fs from 'node:fs';
import path from 'node:path';
import { isoNow, loadDecisionPolicy } from '@mu/harness-foundation';
import { dbCounts, migrate, openDb } from './observe-db.mjs';

function resolveGc(policy) {
    const gc = policy?.storage?.gc;
    if (!gc) return { mode: 'off' };
    return gc;
}

function dirSizeBytes(root) {
    if (!fs.existsSync(root)) return 0;
    let total = 0;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, ent.name);
        if (ent.isDirectory()) total += dirSizeBytes(p);
        else {
            try {
                total += fs.statSync(p).size;
            } catch {
                /* skip */
            }
        }
    }
    return total;
}

/**
 * @param {object} cfg observe config (storage.target, decisionPolicyPath, root, dataDir)
 */
export function storageStatus(cfg) {
    const policy = loadDecisionPolicy({ root: cfg.root, decisionPolicyPath: cfg.decisionPolicyPath }).policy;
    const gc = resolveGc(policy);
    const db = openDb(cfg.storage.target);
    migrate(db);
    const counts = dbCounts(db);
    const ledger = db.get('SELECT COUNT(*) AS n FROM decision_ledger')?.n ?? 0;
    const oldest = db.get('SELECT MIN(created_at) AS at FROM request')?.at ?? null;
    const dbBytes = fs.existsSync(cfg.storage.target) ? fs.statSync(cfg.storage.target).size : 0;
    const blobsDir = path.join(cfg.dataDir || path.join(cfg.root, '.harness'), 'blobs');
    return {
        ok: true,
        at: isoNow(),
        gcMode: gc.mode ?? 'off',
        db: {
            path: cfg.storage.target,
            bytes: dbBytes,
            ...counts,
            ledgerRows: ledger,
            oldestRequestAt: oldest,
        },
        blobs: {
            path: blobsDir,
            bytes: dirSizeBytes(blobsDir),
        },
    };
}

/**
 * G1 storage GC — prune ledger rows per policy (§11).
 * @param {object} cfg
 * @param {{ dryRun?: boolean }} [opts]
 */
export function runStorageGc(cfg, opts = {}) {
    const policy = loadDecisionPolicy({ root: cfg.root, decisionPolicyPath: cfg.decisionPolicyPath }).policy;
    const gc = resolveGc(policy);
    const dryRun = opts.dryRun === true || gc.dryRun === true;
    const observeOnly = gc.mode === 'observe' || dryRun;

    if (gc.mode === 'off') {
        return { ok: true, skipped: true, reason: 'gc_off', at: isoNow() };
    }

    const retentionDays = Number(gc.hot?.retentionDays ?? 90) || 90;
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const pruneTypes = gc.hot?.pruneLedgerEventTypes ?? ['turn_start', 'jev_shadow'];
    const placeholders = pruneTypes.map(() => '?').join(', ');

    const db = openDb(cfg.storage.target);
    migrate(db);

    const candidates = db.all(
        `SELECT id, request_id, event_type, created_at FROM decision_ledger
         WHERE event_type IN (${placeholders}) AND created_at < ?`,
        [...pruneTypes, cutoff],
    );

    const wouldDelete = candidates.length;
    let deleted = 0;
    if (!observeOnly && wouldDelete > 0) {
        const res = db.run(
            `DELETE FROM decision_ledger
             WHERE event_type IN (${placeholders}) AND created_at < ?`,
            [...pruneTypes, cutoff],
        );
        deleted = res.changes ?? wouldDelete;
    }

    let vacuum = false;
    if (!observeOnly && gc.vacuum && deleted > 0 && db.driver === 'sqlite') {
        db.exec('VACUUM');
        vacuum = true;
    }

    return {
        ok: true,
        at: isoNow(),
        mode: gc.mode,
        dryRun: observeOnly,
        retentionDays,
        cutoff,
        wouldDelete,
        deleted: observeOnly ? 0 : deleted,
        vacuum,
    };
}
