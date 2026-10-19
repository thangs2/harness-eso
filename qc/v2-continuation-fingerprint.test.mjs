import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = path.join(ESO_ROOT, 'packages/harness-host-generic/src/dispatcher.mjs');

function runHook(hook, stdinObj, opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const tree = opts.tree || 'agents';
    const args = [DISPATCHER, '--hook', hook, '--tree', tree, ...(opts.args || [])];
    const proc = spawnSync('node', args, {
        input: stdinObj ? `${JSON.stringify(stdinObj)}\n` : '',
        encoding: 'utf8',
        cwd,
        env: { ...process.env, HARNESS_TREE: tree },
    });
    const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    let json = {};
    try {
        json = line ? JSON.parse(line) : {};
    } catch {
        json = { _raw: line, _stderr: proc.stderr };
    }
    return { json, status: proc.status, stderr: proc.stderr, stdout: proc.stdout };
}

function tempConsumer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fp-consumer-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'session'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'test-fp' } }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: 'fail_closed',
                sources: { law: { enabled: false }, code: { enabled: false }, memory: { enabled: false } },
            },
        }),
    );
    return root;
}

test('initial preflight records fingerprint in session projection', () => {
    const root = tempConsumer();
    const res = runHook('preflight', {
        conversationId: 'session-fp-01',
        prompt: 'Implement customer booking service',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });

    assert.equal(res.status, 0);
    const prePath = path.join(root, '.agents', 'session', '.eso-preflight.json');
    assert.ok(fs.existsSync(prePath));
    const pre = JSON.parse(fs.readFileSync(prePath, 'utf8'));
    assert.ok(typeof pre.fingerprint === 'string' && pre.fingerprint.length > 0, 'fingerprint must be recorded');
    assert.equal(pre.conversationId, 'session-fp-01');
    assert.equal(pre.userQueryStem, 'Implement customer booking service');
    fs.rmSync(root, { recursive: true, force: true });
});

test('continuation step with matching stem and clean state short-circuits and preserves gaps', () => {
    const root = tempConsumer();
    const sessionPath = path.join(root, '.agents', 'session');

    // Turn 0: initial preflight
    const t0 = runHook('preflight', {
        conversationId: 'session-fp-02',
        invocationNum: 0,
        prompt: 'Implement customer booking service',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });
    assert.equal(t0.status, 0);

    // Mock gap closure
    const pre = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-preflight.json'), 'utf8'));
    fs.writeFileSync(path.join(sessionPath, '.eso-gap-closure.json'), JSON.stringify({
        ok: true,
        at: pre.at,
        preflightAt: pre.at,
        closedGapIds: ['code:mock-gap'],
    }));

    // Turn 1: continuation with identical prompt stem
    const t1 = runHook('preflight', {
        conversationId: 'session-fp-02',
        invocationNum: 1,
        prompt: 'Implement customer booking service',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });

    assert.equal(t1.status, 0);

    // Gap closure must be preserved because it short-circuited
    const closure = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-gap-closure.json'), 'utf8'));
    assert.deepEqual(closure.closedGapIds, ['code:mock-gap'], 'matching fingerprint must preserve gap closure');

    fs.rmSync(root, { recursive: true, force: true });
});

test('intent drift (prompt changed in same session) invalidates fingerprint and triggers fresh preflight', () => {
    const root = tempConsumer();
    const sessionPath = path.join(root, '.agents', 'session');

    // Turn 0: prompt A
    const t0 = runHook('preflight', {
        conversationId: 'session-fp-03',
        invocationNum: 0,
        prompt: 'Implement customer booking service',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });
    assert.equal(t0.status, 0);

    const pre0 = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-preflight.json'), 'utf8'));
    const fp0 = pre0.fingerprint;

    // Seed mock gap closure
    fs.writeFileSync(path.join(sessionPath, '.eso-gap-closure.json'), JSON.stringify({
        ok: true,
        at: pre0.at,
        preflightAt: pre0.at,
        closedGapIds: ['code:mock-gap'],
    }));

    // Turn 1: user changes intent in same conversation
    const t1 = runHook('preflight', {
        conversationId: 'session-fp-03',
        invocationNum: 1,
        prompt: 'Cancel customer invoice and refund',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });

    assert.equal(t1.status, 0);

    const pre1 = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-preflight.json'), 'utf8'));
    assert.notEqual(pre1.fingerprint, fp0, 'fingerprint must be updated to match the new prompt stem');
    assert.equal(pre1.userQueryStem, 'Cancel customer invoice and refund');

    // Gap closure must have been reset because full preflight ran
    const closure = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-gap-closure.json'), 'utf8'));
    assert.deepEqual(closure.closedGapIds, [], 'gap closure must be reset on intent drift');

    fs.rmSync(root, { recursive: true, force: true });
});

test('dirty working tree (git index change) invalidates fingerprint and forces fresh preflight', () => {
    const root = tempConsumer();
    const sessionPath = path.join(root, '.agents', 'session');

    // Setup git directory
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'index'), 'initial index content');

    // Turn 0: initial preflight with clean git index
    const t0 = runHook('preflight', {
        conversationId: 'session-fp-04',
        invocationNum: 0,
        prompt: 'Check system health status',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });
    assert.equal(t0.status, 0);

    const pre0 = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-preflight.json'), 'utf8'));
    const fp0 = pre0.fingerprint;

    // Simulate dirty repository: modify index mtime
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(gitDir, 'index'), later, later);

    // Turn 1: continuation with same prompt, but git index was touched
    const t1 = runHook('preflight', {
        conversationId: 'session-fp-04',
        invocationNum: 1,
        prompt: 'Check system health status',
        toolCall: {},
    }, { cwd: root, tree: 'agents', args: ['--event', 'PreInvocation'] });

    assert.equal(t1.status, 0);

    const pre1 = JSON.parse(fs.readFileSync(path.join(sessionPath, '.eso-preflight.json'), 'utf8'));
    assert.notEqual(pre1.fingerprint, fp0, 'fresh fingerprint computed reflecting changed index');

    fs.rmSync(root, { recursive: true, force: true });
});
