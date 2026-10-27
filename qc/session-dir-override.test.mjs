import assert from 'node:assert/strict';
import test from 'node:test';

import { SESSION_DIR_ENV, sessionDir } from '../packages/harness-foundation/src/paths.mjs';
import { sessionDir as packSessionDir } from '../packages/harness-host-generic/src/hook-io.mjs';

/*
 * `HARNESS_SESSION_DIR` is only worth having if **both** sides honour it. The guard derives the session
 * dir from its own file path and the pack derives it from the repo root; when those disagreed, the pack
 * wrote `.pipeline-brain-stamp.json` (and `.eso-preflight.json`) into one directory while the guard read
 * another — the write was refused with a message about a file the agent had just written.
 *
 * The in-repo refusal is the other half: a session dir inside the repo is agent-writable, so exempting it
 * from the gate would let the agent forge the evidence the gate exists to check.
 */

const ROOT = '/tmp/harness-sessiondir-fixture';

function withOverride(value, fn) {
    const prev = process.env[SESSION_DIR_ENV];
    if (value === undefined) delete process.env[SESSION_DIR_ENV];
    else process.env[SESSION_DIR_ENV] = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env[SESSION_DIR_ENV];
        else process.env[SESSION_DIR_ENV] = prev;
    }
}

test('without the override every tree keeps its derived directory', () => {
    withOverride(undefined, () => {
        assert.equal(sessionDir(ROOT, 'cursor'), `${ROOT}/.cursor/session`);
        assert.equal(sessionDir(ROOT, 'agents'), `${ROOT}/.agents/session`);
        assert.equal(sessionDir(ROOT, 'claude'), `${ROOT}/.claude/session`);
    });
});

test('the pack and the foundation answer with the same directory', () => {
    for (const override of [undefined, '/tmp/harness-dsh-sessions']) {
        withOverride(override, () => {
            for (const tree of ['cursor', 'agents', 'claude']) {
                assert.equal(
                    packSessionDir(ROOT, tree),
                    sessionDir(ROOT, tree),
                    `pack and foundation disagree for tree=${tree} override=${override}`,
                );
            }
        });
    }
});

test('an absolute out-of-repo override wins over the tree', () => {
    withOverride('/tmp/harness-dsh-sessions', () => {
        assert.equal(sessionDir(ROOT, 'cursor'), '/tmp/harness-dsh-sessions');
        assert.equal(packSessionDir(ROOT, 'agents'), '/tmp/harness-dsh-sessions');
    });
});

test('an in-repo override is refused, not honoured', () => {
    withOverride(`${ROOT}/.dsh/session`, () => {
        assert.throws(() => sessionDir(ROOT, 'cursor'), /must lie outside the repo/);
        assert.throws(() => packSessionDir(ROOT, 'cursor'), /must lie outside the repo/);
    });
});

test('a relative override is refused rather than resolved against the cwd', () => {
    withOverride('.dsh/session', () => {
        assert.throws(() => sessionDir(ROOT, 'cursor'), /must be absolute/);
    });
});
