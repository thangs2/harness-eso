import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import { initEvidenceSchema } from '../eso/evidence/src/schema.mjs';
import { recordTurn } from '../eso/evidence/src/recorder.mjs';
import {
    electCapabilityProvider,
    setCapabilityPin,
    loadCapabilityPins,
    queryTurnProviderAudit,
} from '../eso/adapters/src/index.mjs';

/**
 * ESO-382: pins and turn audit must survive a process restart.
 *
 * The previous tests here used `:memory:` (nothing survives a restart) and asserted the
 * `provider_audit` table while claiming to read the evidence store. These versions use a
 * real SQLite file, close the handle between writes and reads, and write the audit trail
 * through the canonical evidence recorder so the read path is genuinely exercised.
 */

function withTempDb(tag, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
    const dbFile = path.join(dir, 'eso.db');
    try {
        return fn(dbFile);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('ESO-382 / SCN-HOST-12: capability pin persists across a real restart and drives election', () => {
    withTempDb('eso-pin-restart', (dbFile) => {
        const branches = {
            'host-native': { available: true, provider_id: 'cursor-cg' },
            'eso-native': { available: true, provider_id: 'eso-cg' },
        };

        // 1. Operator pins codegraph to eso-native, then the process/handle goes away.
        let db = createDbAdapter(dbFile);
        const pins = setCapabilityPin({
            project: 'p1',
            capabilityKind: 'codegraph',
            targetBranch: 'eso-native',
            actorRole: 'operator',
            db,
        });
        assert.equal(pins.codegraph, 'eso-native');
        db.close();

        // 2. Fresh handle on the same file: the pin must come from disk, not memory.
        db = createDbAdapter(dbFile);
        assert.deepEqual(loadCapabilityPins({ project: 'p1', db }), { codegraph: 'eso-native' });

        const election = electCapabilityProvider({
            project: 'p1',
            turnId: 'turn-restart-1',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(election.branch, 'eso-native', 'pin must beat branch order after restart');
        assert.equal(election.pinned, true);

        // The pin is scoped to its project, not to the whole store.
        const otherProject = electCapabilityProvider({
            project: 'p2',
            turnId: 'turn-restart-2',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(otherProject.branch, 'host-native');
        assert.notEqual(otherProject.pinned, true);

        // 3. RBAC still applies on the reopened store: an agent cannot mutate the pin.
        assert.throws(
            () => {
                setCapabilityPin({
                    project: 'p1',
                    capabilityKind: 'codegraph',
                    targetBranch: 'external',
                    actorRole: 'agent',
                    db,
                });
            },
            (err) => err.code === 'FORBIDDEN_MUTATION'
        );

        // 4. Empty pin removes it, and branch order takes over again.
        setCapabilityPin({
            project: 'p1',
            capabilityKind: 'codegraph',
            targetBranch: '',
            actorRole: 'operator',
            db,
        });
        assert.equal(loadCapabilityPins({ project: 'p1', db }).codegraph, undefined);

        const afterRemoval = electCapabilityProvider({
            project: 'p1',
            turnId: 'turn-restart-3',
            capabilityKind: 'codegraph',
            host: 'cursor',
            branches,
            db,
        });
        assert.equal(afterRemoval.branch, 'host-native');
        assert.notEqual(afterRemoval.pinned, true);
        db.close();
    });
});

test('ESO-382 / B4: turn provider audit reads elections from the canonical evidence store after a restart', () => {
    withTempDb('eso-audit-evidence', (dbFile) => {
        const turnAt = '2026-11-05T02:00:00.000Z';
        const turnId = 'turn-audit-123';

        // 1. Canonical evidence store; elections are written by the canonical recorder.
        let db = createDbAdapter(dbFile);
        initEvidenceSchema(db);
        recordTurn(
            db,
            {
                project: 'p1',
                turn_id: turnId,
                at: turnAt,
                resolved: [
                    {
                        capability: 'subagents',
                        branch: 'host-native',
                        provider_id: 'cursor-subagents',
                        guarantee: 'G-FULL',
                        reason: 'Elected host native',
                        history: [{ branch: 'host-native', status: 'elected' }],
                    },
                    {
                        capability: 'codegraph_query',
                        branch: 'none',
                        provider_id: null,
                        guarantee: 'G-DEGRADED',
                        reason: 'Fallback to none',
                        history: [{ branch: 'none', status: 'fallback' }],
                    },
                ],
            },
            { isRuntime: true }
        );

        // 2. Audit reads the evidence items, not a separate audit table.
        const res = queryTurnProviderAudit({ turnId, project: 'p1', db });
        assert.equal(res.turn_id, turnId);
        assert.equal(res.records.length, 2);
        assert.equal(res.has_degraded, true);
        const subRecord = res.records.find((r) => r.capability === 'subagents');
        const cgRecord = res.records.find((r) => r.capability === 'codegraph_query');
        assert.ok(subRecord);
        assert.ok(cgRecord);
        assert.equal(cgRecord.branch, 'none');
        assert.equal(cgRecord.reason, 'Fallback to none');
        // evidence_item has no timestamp of its own; the turn time must be used.
        assert.equal(subRecord.recorded_at, turnAt);
        assert.equal(cgRecord.recorded_at, turnAt);
        db.close();

        // 3. Restart: a fresh handle must produce the same audit.
        db = createDbAdapter(dbFile);
        const afterRestart = queryTurnProviderAudit({ turnId, project: 'p1', db });
        assert.deepEqual(afterRestart.records, res.records);
        assert.equal(afterRestart.has_degraded, true);
        db.close();
    });
});
