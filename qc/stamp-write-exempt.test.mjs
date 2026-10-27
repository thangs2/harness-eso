import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * `eso.cognition.stampWrites: "exempt"` — the agent may write the Brain stamp without the host prompting.
 *
 * This is an **opt-in relaxation**, and the test is written to keep it honest: the default must stay
 * unchanged for every existing consumer, and the exemption must not leak onto any other path. What it buys
 * is convenience on a tree whose guard reads the DeepSeek ledger first; what it costs is that a tree
 * relying on the legacy stamp can now be satisfied by the agent itself. That trade is the consumer's to
 * make, which is why it is a declaration and not a default.
 */

const GUARD = path.resolve(import.meta.dirname, '../profiles/templates/hooks/guard-write.py');

function consumer(policy = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-exempt-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ project: { id: 'stamp-qc' } }));
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            paths: { locked: [], gated: ['src/'], ask: [] },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'off', cognition: { enforceBrain: 'off' }, ...policy },
        }),
    );
    fs.copyFileSync(GUARD, path.join(root, '.cursor', 'hooks', 'guard-write.py'));
    return root;
}

function write(root, rel, env = {}) {
    const res = spawnSync('python3', [path.join(root, '.cursor', 'hooks', 'guard-write.py')], {
        input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 's',
            cwd: root,
            tool_name: 'Write',
            tool_input: { file_path: rel, content: '{"ok":true}' },
        }),
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_TREE: 'cursor', ...env },
    });
    return JSON.parse(res.stdout || '{}');
}

const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? out?.permission;

test('the stamp is allowed with no policy key — unchanged default', () => {
    const root = consumer();
    assert.equal(decision(write(root, '.cursor/session/.pipeline-brain-stamp.json')), 'allow');
});

test('the exemption does not leak onto an ordinary gated path', () => {
    /*
     * The switch names two filenames. It must not widen to the session directory or to a gated path: a
     * consumer that turned it on to stop one prompt has not agreed to stop the gate.
     */
    const root = consumer({ cognition: { enforceBrain: 'on', stampWrites: 'exempt' } });
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            paths: { locked: [], gated: ['src/'], ask: ['sdlc/'] },
            eso: { enabled: true, mode: 'hint', enforceWrites: 'off', cognition: { enforceBrain: 'fail_closed', stampWrites: 'exempt' } },
        }),
    );
    assert.equal(decision(write(root, 'src/app.mjs')), 'deny', 'a gated path still stops at the Brain gate');
    assert.equal(decision(write(root, 'sdlc/x.md')), 'deny', 'an `ask` tier path still refuses without consent');
    assert.equal(decision(write(root, '.cursor/session/.pipeline-brain-stamp.json')), 'allow', 'the stamp itself is exempt');
});

test('HARNESS_STAMP_WRITES=exempt works without touching the policy file', () => {
    const root = consumer();
    assert.equal(decision(write(root, '.cursor/session/.pipeline-brain-stamp.json', { HARNESS_STAMP_WRITES: 'exempt' })), 'allow');
});

test('the brain-unavailable sentinel is covered by the same switch', () => {
    const root = consumer({ cognition: { enforceBrain: 'off', stampWrites: 'exempt' } });
    assert.equal(decision(write(root, '.cursor/session/.brain-unavailable.json')), 'allow');
});

test('an unknown value for the key leaves the default alone', () => {
    const root = consumer({ cognition: { enforceBrain: 'off', stampWrites: 'sometimes' } });
    assert.equal(decision(write(root, '.cursor/session/.pipeline-brain-stamp.json')), 'allow');
});
