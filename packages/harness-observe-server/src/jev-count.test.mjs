import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDb } from '@mu/harness-foundation';
import { refreshMcpCallStats } from './mcp-call-stats.mjs';
import { migrate } from './observe-db.mjs';

/**
 * A ledger row, shaped the way each writer actually writes it.
 *
 * The two writers disagree about `jev_response_json`, which is the whole point of this file:
 * `decide.mjs` puts a Jev API response there (only when Jev returned), while `insertEvidenceLedger`
 * parks the **ESO bundle** in it so the ESO view can read it back.
 */
function ledgerRow(db, { id, eventType, jevMode, latencyMsJev, jevResponseJson }) {
    db.run(
        `INSERT INTO decision_ledger (id, project_id, request_id, event_type, jev_mode,
            enforced_verdict, ambiguous_policy, latency_ms_l0, latency_ms_jev, jev_request_hash,
            jev_response_json, created_at)
         VALUES (?, 'p', 'c:1', ?, ?, 'verdict', 'hil_only', 1, ?, ?, ?, datetime('now'))`,
        [id, eventType, jevMode, latencyMsJev, `hash-${id}`, jevResponseJson],
    );
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-jev-count-'));
    const dbPath = path.join(dir, 't.db');
    const db = openDb(dbPath);
    migrate(db);
    db.run(
        `INSERT INTO project (id, display_name, root_path, config_path, storage_driver, storage_target, created_at, updated_at)
         VALUES ('p', 'p', '/r', '/r/harness.config.json', 'sqlite', ?, datetime('now'), datetime('now'))`,
        [dbPath],
    );
    db.run(
        `INSERT INTO conversation (id, project_id, created_at, updated_at) VALUES ('c', 'p', datetime('now'), datetime('now'))`,
    );
    db.run(`INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, status, created_at, updated_at)
            VALUES ('c:1', 'p', 'c', 1, 'hi', 'completed', datetime('now'), datetime('now'))`);
    return { db, dbPath };
}

/**
 * `jev_count` used to count any ledger row with a non-empty `jev_response_json`. But
 * `insertEvidenceLedger` parks the whole ESO bundle in that column, so **every** ESO row counted as a
 * Jev call. Measured on x79 before the fix: 3,238 of 3,238 requests reported `jev_count=1` while the
 * policy had `jev.mode: "off"` and no row had `latency_ms_jev > 0` — Jev had never run once, and the
 * monitor asserted otherwise on every single request.
 *
 * The test asserts the exact production shape: an ESO row carrying a bundle in the Jev column, with
 * zero latency, must not be counted.
 */
test('an ESO row carrying its bundle in jev_response_json is not counted as a Jev call', () => {
    const { db } = fixture();
    try {
        ledgerRow(db, {
            id: 'eso1',
            eventType: 'evidence_sufficiency',
            jevMode: 'hint',
            latencyMsJev: 0,
            // Exactly what `insertEvidenceLedger` writes: the ESO bundle, no Jev involved.
            jevResponseJson: JSON.stringify({ sufficiency: { level: 'partial', score: 0.55 } }),
        });

        refreshMcpCallStats(db, 'p');
        assert.equal(
            db.get('SELECT jev_count FROM mcp_call_stats WHERE request_id = ?', ['c:1']).jev_count,
            0,
            'an ESO verdict is not a Jev call',
        );
    } finally {
        db.close();
    }
});

test('a real Jev call is counted, from either writer', () => {
    const { db } = fixture();
    try {
        // Facade path: `decide.mjs` records the Jev latency and the API response.
        ledgerRow(db, {
            id: 'j1',
            eventType: 'turn_start',
            jevMode: 'active',
            latencyMsJev: 42,
            jevResponseJson: JSON.stringify({ route: { winnerId: 'rule:docs' } }),
        });
        // ESO path: `eso-ledger.mjs` records `row.jev_latency_ms` and wraps the trace under `jev`.
        ledgerRow(db, {
            id: 'j2',
            eventType: 'evidence_sufficiency',
            jevMode: 'active',
            latencyMsJev: 7,
            jevResponseJson: JSON.stringify({ bundle: { sufficiency: {} }, jev: { ok: true } }),
        });

        refreshMcpCallStats(db, 'p');
        // Distinct hashes, so two calls — the count is of requests, not rows.
        assert.equal(db.get('SELECT jev_count FROM mcp_call_stats WHERE request_id = ?', ['c:1']).jev_count, 2);
    } finally {
        db.close();
    }
});

test('a decision with no Jev involvement does not inflate the count', () => {
    // The ordinary case: `turn_start` with `jev_mode: off` and no latency. A row exists, but no Jev
    // call did — which the old predicate could not express.
    const { db } = fixture();
    try {
        ledgerRow(db, {
            id: 'l0only',
            eventType: 'turn_start',
            jevMode: 'off',
            latencyMsJev: 0,
            jevResponseJson: null,
        });
        refreshMcpCallStats(db, 'p');
        assert.equal(db.get('SELECT jev_count FROM mcp_call_stats WHERE request_id = ?', ['c:1']).jev_count, 0);
    } finally {
        db.close();
    }
});

test('the count is not doubled by the two rows one decision can produce', () => {
    // One decision can be recorded on both a `turn_start` and an `evidence_sufficiency` row for the
    // same request. They share a `jev_request_hash`, so they must collapse to one call.
    const { db } = fixture();
    try {
        const shared = JSON.stringify({ ok: true });
        db.run(
            `INSERT INTO decision_ledger (id, project_id, request_id, event_type, jev_mode,
                enforced_verdict, ambiguous_policy, latency_ms_l0, latency_ms_jev, jev_request_hash,
                jev_response_json, created_at)
             VALUES ('a', 'p', 'c:1', 'turn_start', 'active', 'v', 'hil_only', 1, 30, 'same-hash', ?, datetime('now')),
                    ('b', 'p', 'c:1', 'evidence_sufficiency', 'active', 'v', 'hil_only', 1, 30, 'same-hash', ?, datetime('now'))`,
            [shared, shared],
        );
        refreshMcpCallStats(db, 'p');
        assert.equal(db.get('SELECT jev_count FROM mcp_call_stats WHERE request_id = ?', ['c:1']).jev_count, 1);
    } finally {
        db.close();
    }
});
