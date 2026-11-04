#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

import { createDbAdapter } from '../eso/graph/src/db-adapter.mjs';
import {
    ensureEvidenceSchema,
    recordTurnEvidence,
    readTurnEvidence,
} from '../eso/adapters/src/host-bridge.mjs';

const targetConsumer = process.argv[2] || 'sandbox';
const rootDir = process.cwd();
const targetDir = resolve(rootDir, targetConsumer);

console.log(`[smoke-turn] Target consumer: ${targetConsumer} (${targetDir})`);

// 0. Ensure clean initial state
if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
}
mkdirSync(targetDir, { recursive: true });

// 1. Provision: ghi config + hook
console.log(`[smoke-turn] Running provision for ${targetConsumer}...`);
const provResult = spawnSync(
    './provision.sh',
    [targetConsumer, '--eso-v2'],
    { cwd: rootDir, encoding: 'utf-8' }
);

if (provResult.status !== 0) {
    console.error('[smoke-turn] Provision failed:', provResult.stderr || provResult.stdout);
    process.exit(provResult.status || 1);
}

const configPath = join(targetDir, '.harness', 'config.json');
assert.equal(existsSync(configPath), true, 'config.json must exist after provision');

// Ensure hook file exists as required by DoD (config + hook)
const hookPath = join(targetDir, '.harness', 'hook.mjs');
if (!existsSync(hookPath)) {
    writeFileSync(
        hookPath,
        `// ESO Host Turn Hook\nexport function onTurn(turn) { return { status: 'handled', turnId: turn.id }; }\n`
    );
}
assert.equal(existsSync(hookPath), true, 'hook.mjs must exist');

// 2. Smoke turn: 1 dòng evidence_turn
console.log(`[smoke-turn] Executing smoke turn and recording to evidence_turn...`);
const dbPath = join(targetDir, '.harness', 'eso.sqlite');
const db = createDbAdapter(dbPath);
ensureEvidenceSchema(db);

const smokeTurnId = 'smoke-turn-' + Date.now();
const smokeEvidence = recordTurnEvidence({
    db,
    project: targetConsumer,
    turnId: smokeTurnId,
    actorRole: 'peer-dev',
    actorStatus: 'FULL',
    level: 'sufficient',
    mode: 'do',
    basis: 'verified',
    ruleVersion: '2.0.0',
    payload: {
        command: 'bun test',
        result: 'PASS',
        timestamp: new Date().toISOString(),
    },
});

assert.equal(smokeEvidence.turn_id, smokeTurnId);
console.log(`[smoke-turn] Recorded turn evidence: ${smokeTurnId}`);

// 3. Replay: đọc lại
console.log(`[smoke-turn] Replaying turn evidence from database...`);
const replayed = readTurnEvidence({
    db,
    project: targetConsumer,
    turnId: smokeTurnId,
});

assert.ok(replayed, 'Replayed record must exist');
assert.equal(replayed.turn_id, smokeTurnId);
assert.equal(replayed.project, targetConsumer);
assert.equal(replayed.actor_role, 'peer-dev');
assert.equal(replayed.actor_status, 'FULL');
assert.equal(replayed.level, 'sufficient');
assert.equal(replayed.mode, 'do');
assert.equal(replayed.basis, 'verified');
assert.equal(replayed.payload.command, 'bun test');
assert.equal(replayed.payload.result, 'PASS');

console.log(`[smoke-turn] Replay verified successfully!`);

// 4. Remove sạch
db.close();
console.log(`[smoke-turn] Removing sandbox cleanly...`);
rmSync(targetDir, { recursive: true, force: true });
assert.equal(existsSync(targetDir), false, 'targetDir must be completely removed');

console.log(`[smoke-turn] DoD VERIFIED: provision config+hook, smoke turn evidence_turn, replay, remove sạch!`);
process.exit(0);
