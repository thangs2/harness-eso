import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Every hook is exercised through the dispatcher, never by running its module directly. That is
 * the only path the consumer takes, so it is the only path worth asserting on: it covers the
 * `--hook`/`--tree` contract, the response dialect per IDE, and the error posture.
 */
const DISPATCHER = path.join(ESO_ROOT, 'packages/harness-host-generic/src/dispatcher.mjs');

function runHook(hook, stdinObj, opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const tree = opts.tree || 'cursor';
    const args = [DISPATCHER, '--hook', hook, '--tree', tree, ...(opts.args || [])];
    const proc = spawnSync('node', args, {
        input: stdinObj ? `${JSON.stringify(stdinObj)}\n` : '',
        encoding: 'utf8',
        cwd,
        // Deliberately no HARNESS_ESO_ROOT: the pack must not need it. If a hook reintroduces
        // that dependency, these tests fail.
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

function tempConsumer(opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guards-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: opts.enforceWrites || 'fail_closed',
                cognition: { enforceBrain: 'fail_closed', gapAttestation: true },
            },
        }),
    );
    return root;
}

test('guard-shell denies DROP DATABASE', () => {
    const root = tempConsumer();
    const { json } = runHook('guard-shell', { command: 'mongosh --eval "drop database foo"' }, { cwd: root });
    assert.equal(json.permission, 'deny');
});

test('guard-shell allows benign command', () => {
    const root = tempConsumer();
    const { json } = runHook('guard-shell', { command: 'bun test' }, { cwd: root });
    assert.equal(json.permission, 'allow');
});

test('gap-tracker closes gap after Read tool', () => {
    const root = tempConsumer();
    const preflightAt = new Date().toISOString();
    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            ok: true,
            at: preflightAt,
            level: 'partial',
            score: 0.5,
            gaps: [{ kind: 'law', query: 'harness-eso' }],
        }),
    );
    const { json } = runHook(
        'gap-tracker',
        {
            tool_name: 'Read',
            tool_input: { path: 'document/harness/02.harness-eso/00.index.md' },
            generation_id: 'g1',
        },
        { cwd: root },
    );
    assert.equal(json.permission, 'allow');
    const closure = JSON.parse(
        fs.readFileSync(path.join(root, '.cursor', 'session', '.eso-gap-closure.json'), 'utf8'),
    );
    assert.equal(closure.preflightAt, preflightAt);
    assert.ok(closure.closedGapIds.includes('law:harness-eso'));
});

test('guard-brain blocks ask_deepseek when gaps open', () => {
    const root = tempConsumer();
    const preflightAt = new Date().toISOString();
    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            ok: true,
            at: preflightAt,
            level: 'partial',
            gaps: [{ kind: 'code', query: 'decide.mjs' }],
        }),
    );
    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-gap-closure.json'),
        JSON.stringify({
            ok: true,
            preflightAt,
            requiredGapIds: ['code:decide.mjs'],
            closedGapIds: [],
            allClosed: false,
        }),
    );
    const { json } = runHook('guard-brain', { tool_name: 'ask_deepseek_flash' }, { cwd: root });
    assert.equal(json.permission, 'deny');
});

test('post-tool-hint emits additional_context once per generation', () => {
    const root = tempConsumer();
    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            ok: true,
            at: '2026-10-12T01:00:00.000Z',
            level: 'partial',
            score: 0.4,
            gaps: [{ kind: 'memory', query: 'eso' }],
        }),
    );
    const env = { cwd: root };
    const first = runHook('post-tool-hint', { generation_id: 'gen-hint-1', tool_name: 'Read' }, env);
    assert.ok(first.json.additional_context);
    const second = runHook('post-tool-hint', { generation_id: 'gen-hint-1', tool_name: 'Read' }, env);
    assert.equal(second.json.additional_context, undefined);
});

// ---------------------------------------------------------------------------
// Dispatcher contract and error posture
// ---------------------------------------------------------------------------

test('dispatcher denies when --hook is missing instead of guessing', () => {
    const { json } = runHook('', { command: 'ls' }, {});
    assert.equal(json.permission, 'deny');
    assert.match(json.user_message, /--hook/);
});

test('dispatcher denies an unknown hook', () => {
    const { json } = runHook('not-a-hook', { command: 'ls' }, {});
    assert.equal(json.permission, 'deny');
    assert.match(json.user_message, /unknown hook/);
});

test('antigravity payload gets the decision dialect, not the cursor permission dialect', () => {
    const root = tempConsumer();
    // The dialect follows the HOST PAYLOAD, not `--tree`: a caller that already speaks
    // Antigravity must be answered in Antigravity's shape.
    const { json } = runHook(
        'guard-shell',
        { conversationId: 'c1', stepIdx: 1, toolCall: { name: 'run_command', args: { command: 'ls -la' } } },
        { cwd: root, tree: 'agents' },
    );
    assert.equal(json.decision, 'allow');
    assert.equal(json.permission, undefined);
});

test('pre-compact always allows even with an unparseable payload', () => {
    const root = tempConsumer();
    const proc = spawnSync('node', [DISPATCHER, '--hook', 'pre-compact', '--tree', 'cursor'], {
        input: 'not json\n',
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, HARNESS_TREE: 'cursor' },
    });
    const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    assert.equal(JSON.parse(line).permission, 'allow');
});

// ---------------------------------------------------------------------------
// Error posture (`guards.unavailable`)
// ---------------------------------------------------------------------------

test('a guard that cannot decide denies by default', () => {
    const root = tempConsumer();
    // A corrupt policy makes the guard throw. Treating that as `allow` is how an enforcement
    // layer silently stops enforcing, so the default must block.
    fs.writeFileSync(path.join(root, '.harness', 'decision-policy.json'), '{ not json');
    const { json } = runHook('guard-shell', { command: 'bun test' }, { cwd: root });
    assert.equal(json.permission, 'deny');
    assert.equal(json.hookError, true);
});

test('a telemetry hook that cannot run still allows', () => {
    const root = tempConsumer();
    fs.writeFileSync(path.join(root, '.harness', 'decision-policy.json'), '{ not json');
    const { json } = runHook('pre-compact', { generation_id: 'g' }, { cwd: root });
    assert.equal(json.permission, 'allow');
});

test('errorPosture honours guards.unavailable and never loosens a telemetry hook', async () => {
    const { errorPosture } = await import('../packages/harness-host-generic/src/dispatch.mjs');
    assert.equal(errorPosture('guard-shell'), 'deny');
    assert.equal(errorPosture('guard-shell', { unavailable: 'warn' }), 'warn');
    assert.equal(errorPosture('guard-shell', { unavailable: 'deny' }), 'deny');
    // Nonsense values fall back to the hook's own default rather than to something permissive.
    assert.equal(errorPosture('guard-shell', { unavailable: 'whatever' }), 'deny');
    // A telemetry hook is never promoted to deny: breaking a turn over a failed trace line is a
    // worse bug than the missing line.
    assert.equal(errorPosture('pre-compact', { unavailable: 'deny' }), 'allow');
    assert.equal(errorPosture('not-a-hook'), 'deny');
});

