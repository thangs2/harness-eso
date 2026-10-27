import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * A third host — DSH — keeps its session dir outside the repo (`~/.dsh/sessions`) and runs the same
 * hook file. Before `HARNESS_SESSION_DIR`, `SESSION_REL` could only be `.cursor/session` or
 * `.agents/session`, so DSH could neither read its own stamp nor be told why. These cases pin the two
 * properties that make the override safe: an unset override is byte-identical to today, and an override
 * inside the repo is refused instead of silently exempted.
 */

const TEMPLATE = path.resolve(import.meta.dirname, '../profiles/templates/hooks/guard-write.py');

function consumer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-'));
    fs.mkdirSync(path.join(root, '.cursor', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ project: { id: 'dsh-qc' } }),
    );
    // Evidence gate off: these tests are about the Brain gate, and a missing attestation would deny first.
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            eso: { enabled: true, mode: 'hint', enforceWrites: 'off', cognition: { enforceBrain: 'fail_closed' } },
            paths: { locked: [], gated: ['src/'], ask: [] },
        }),
    );
    const script = path.join(root, '.cursor', 'hooks', 'guard-write.py');
    fs.copyFileSync(TEMPLATE, script);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-state-'));
    return { root, script, state };
}

function writeInput(root, rel) {
    return JSON.stringify({
        session_id: 'dsh-sess',
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: rel, content: 'export const x = 1;\n' },
    });
}

function run(script, root, rel, extraEnv = {}) {
    const res = spawnSync('python3', [script], {
        input: writeInput(root, rel),
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            HARNESS_TREE: 'cursor',
            HARNESS_ALLOW_SESSION_STAMP_FALLBACK: '1',
            ...extraEnv,
        },
    });
    // Written in the Claude dialect (env tree = cursor, payload has hook_event_name): one decision field
    // serves every tree, so this reads the same on Cursor and on DSH.
    const out = JSON.parse(res.stdout || '{}');
    return { res, out, permission: out?.hookSpecificOutput?.permissionDecision ?? out?.permission };
}

function freshLedger(dir) {
    const ledger = path.join(dir, 'deepseek-usage.jsonl');
    fs.writeFileSync(
        ledger,
        `${JSON.stringify({ ledger: 1, at: new Date().toISOString(), role: 'pro', model: 'deepseek-v4-pro', httpStatus: 200, outcome: 'ok' })}\n`,
    );
    return ledger;
}

test('HARNESS_SESSION_DIR unset keeps the derived .cursor/session path (case 4)', () => {
    const { root, script, state } = consumer();
    const ledger = freshLedger(state);
    const { res, out, permission } = run(script, root, 'src/a.mjs', { DEEPSEEK_USAGE_LEDGER: ledger, HARNESS_PRODUCT_STATE_DIR: state });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(permission, 'allow', JSON.stringify(out));
});

test('legacy session stamp still rescues a stale ledger on the Cursor tree (cases 1–2)', () => {
    const { root, script, state } = consumer();
    const stamp = path.join(root, '.cursor', 'session', '.pipeline-brain-stamp.json');
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify({ ok: true, via: 'ask_deepseek_pro', at: new Date().toISOString() }));
    const { res, out, permission } = run(script, root, 'src/a.mjs', {
        DEEPSEEK_USAGE_LEDGER: path.join(state, 'absent.jsonl'),
        HARNESS_PRODUCT_STATE_DIR: state,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(permission, 'allow', JSON.stringify(out));
});

test('out-of-repo session dir with a fresh ledger allows the write (case 5)', () => {
    const { root, script, state } = consumer();
    const sessionDir = path.join(state, 'dsh-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const ledger = freshLedger(state);
    const { res, out, permission } = run(script, root, 'src/a.mjs', {
        DEEPSEEK_USAGE_LEDGER: ledger,
        HARNESS_PRODUCT_STATE_DIR: state,
        HARNESS_SESSION_DIR: sessionDir,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(permission, 'allow', JSON.stringify(out));
});

test('out-of-repo session dir with an empty ledger denies and names the ledger (case 6)', () => {
    const { root, script, state } = consumer();
    const sessionDir = path.join(state, 'dsh-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const ledger = path.join(state, 'deepseek-usage.jsonl');
    const { res, out, permission } = run(script, root, 'src/a.mjs', {
        DEEPSEEK_USAGE_LEDGER: ledger,
        HARNESS_PRODUCT_STATE_DIR: state,
        HARNESS_SESSION_DIR: sessionDir,
    });
    const reason = JSON.stringify(out);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(permission, 'deny');
    assert.match(reason, /deepseek-usage\.jsonl/, 'names the ledger it read');
    assert.match(reason, /MCP server could not write it/, 'names the actual cause');
    assert.match(reason, /Writing the session stamp will not help/, 'does not send the reader to a file nobody reads');
    assert.match(reason, /dsh-sessions/, 'names the session dir actually in force');
});

test('an in-repo HARNESS_SESSION_DIR is refused, not silently exempted (case 7)', () => {
    const { root, script, state } = consumer();
    const { res } = run(script, root, 'src/a.mjs', {
        DEEPSEEK_USAGE_LEDGER: path.join(state, 'absent.jsonl'),
        HARNESS_PRODUCT_STATE_DIR: state,
        HARNESS_SESSION_DIR: path.join(root, '.dsh', 'session'),
    });
    assert.notEqual(res.status, 0, 'the hook must fail loudly');
    assert.match(res.stderr, /must lie outside the repo/, res.stderr);
});

test('one template serves every tree (case 8)', () => {
    /*
     * `HARNESS_DIR` is derived from the hook's own path, which is only sound because the installer copies
     * ONE file into `.cursor/`, `.agents/` and `.claude/`. If a tree ever gets its own copy of the script,
     * the derivation comment becomes a lie and one tree ends up gating another tree's session dir.
     */
    const template = fs.readFileSync(TEMPLATE, 'utf8');
    assert.match(template, /^HARNESS_DIR = Path\(__file__\)\.resolve\(\)\.parents\[1\]\.name$/m, 'tree is still derived');
    assert.equal(
        (template.match(/^HARNESS_SESSION_DIR/gm) || []).length,
        0,
        'the override has one reader, in `_SESSION_OVERRIDE`',
    );
    assert.match(template, /_SESSION_OVERRIDE = os\.environ\.get\("HARNESS_SESSION_DIR"/);
});
