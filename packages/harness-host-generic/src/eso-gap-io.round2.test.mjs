/**
 * Regression tests for the gap-closure defects found across the `baplatform` / `atrievefin` / `fineso`
 * sessions of 2026-10-23. Each test names the session that produced the failure, because a test that
 * says *why* it exists is the only kind a reader can trust when it goes green.
 *
 * The evidence is in `comments/artifacts/{baplatform,atrievefin,fineso}/`; the synthesis is
 * `comments/artifacts/problem-matrix-2026-10-23.md` (P-01, P-02, P-04, P-28).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    bundleStampPath,
    closesGap,
    gapKindsForTool,
    mergeGapClosure,
    recordGapToolUse,
} from './eso-gap-io.mjs';

const READ_COUNT_GAP = { kind: 'code', query: 'need at least 1 file read(s); have 0' };

function tempRoot(prefix = 'eso-gap-r2-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    return root;
}

function seedPreflight(root, gaps, extra = {}) {
    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            at: '2026-10-23T03:28:38Z',
            level: 'insufficient',
            score: 0,
            allowWrite: false,
            enforceWrites: 'fail_closed',
            mode: 'hint',
            gaps,
            ...extra,
        }),
    );
}

function readClosure(root) {
    return JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'session', '.eso-gap-closure.json'), 'utf8'));
}

const closes = (gap, toolInput, toolName, opts = {}) =>
    closesGap(gap, gapKindsForTool(toolName, toolInput), toolInput, toolName, opts);

/* ── P-01 · a law gap closes on a reading of the law, not on a term in any argument blob ──────── */

test('P-01: baplatform — a rg over a scope-file comment does NOT close law:pipeline-gate', () => {
    /*
     * The measured closure: `docgraph.scope … grep pipeline-gate` closed the gap because the whole
     * Shell argument blob was folded and searched. That turn reached `sufficient / 1.00 /
     * allowWrite:true` (baplatform, 2026-10-23T03:30:56Z) without opening the rule.
     */
    const gap = { kind: 'law', query: 'pipeline-gate' };
    const shell = { command: 'grep -n "pipeline-gate" docgraph.scope' };
    assert.equal(closes(gap, shell, 'Shell'), false);
});

test('P-01: a jq over harness state does not close a law gap either', () => {
    const gap = { kind: 'law', query: 'harness-tooling' };
    const shell = { command: 'jq -r ".gates[] | select(.id==\\"harness-tooling\\")" .harness/state.json' };
    assert.equal(closes(gap, shell, 'Shell'), false);
});

test('P-01: asking docgraph the same question the gate asked DOES close it', () => {
    /*
     * The adapter's own query is the evidence the gate is entitled to score: the turn performed the
     * reading the preflight was asking for. `fineso` never got this far because the index cannot
     * answer the term (P-26) — but the *attempt* is the closure, and refusing it made a diagnostic
     * turn structurally unable to progress.
     */
    const gap = { kind: 'law', query: 'pipeline-gate' };
    assert.equal(closes(gap, { command: 'docgraph --q "pipeline-gate"' }, 'Shell'), true);
    assert.equal(closes(gap, { query: 'pipeline-gate', type: 'doc' }, 'docgraph'), true);
});

test('P-01: a Grep whose pattern IS the term closes it; the same word in a longer pattern does not', () => {
    const gap = { kind: 'law', query: 'pipeline-gate' };
    assert.equal(closes(gap, { pattern: 'pipeline-gate' }, 'Grep'), true);
    // A pattern is a question only when it is the term — `pipeline-gates?` is not the gate.
    assert.equal(closes(gap, { pattern: 'pipeline-gates-archive' }, 'Grep'), false);
});

test('P-01: an MCP tool carrying the query under `arguments` still closes it', () => {
    const gap = { kind: 'law', query: 'decision-facade' };
    const input = { name: 'Grep', arguments: { pattern: 'decision-facade', path: 'sdlc' } };
    // Real MCP calls reach the hook as their own tool name, with the arguments nested one level down.
    assert.equal(closes(gap, input, 'mcp__grep'), true);
    assert.equal(closes(gap, input, 'Grep'), true);
});

/* ── P-02 · harness state is not law ─────────────────────────────────────────────────────────── */

test('P-02: reading the docgraph cache does not close a law gap', () => {
    /*
     * `.harness/cache/docgraph/<sha256>.txt` holds the adapter's own answer *and its query text*, so a
     * Read of it matched the term without the rule ever being opened. `baplatform` F-02 recorded this
     * as a second, independent way to pay the gate with its own output.
     */
    const gap = { kind: 'law', query: 'pipeline-gate' };
    const cache = { path: '.harness/cache/docgraph/9f2c1e.txt' };
    assert.equal(closes(gap, cache, 'Read'), false);
    const named = { path: '.harness/cache/docgraph/core.pipeline-gate.mdc' };
    assert.equal(closes(gap, named, 'Read'), false, 'even a cache file whose name carries the stem');
});

test('P-02: the rule itself still closes it — excluding harness state must not exclude the law', () => {
    const gap = { kind: 'law', query: 'pipeline-gate' };
    assert.equal(closes(gap, { path: '.cursor/rules/core.pipeline-gate.mdc' }, 'Read'), true);
    assert.equal(closes(gap, { path: '.agents/rules/core.pipeline-gate.md' }, 'Read'), true);
});

/* ── P-04 · the code gap measures inspection, not which tool performed it ────────────────────── */

test('P-04: a Shell command that opens a source file closes the read gap', () => {
    /*
     * `fineso`: 16 Read calls (all `.md`, `.py` under `.cursor`, or outside root) and 75 Shell commands
     * inspecting the tree closed nothing, so a read-only audit was structurally unable to reach
     * `sufficient` — the score measured tool choice.
     */
    const opts = { root: '/repo/app' };
    assert.equal(closes(READ_COUNT_GAP, { command: "sed -n '1,40p' src/server.mjs" }, 'Shell', opts), true);
    assert.equal(closes(READ_COUNT_GAP, { command: 'rg -n "detectGaps" packages/core/src/collect.mjs' }, 'Shell', opts), true);
    assert.equal(closes(READ_COUNT_GAP, { command: 'cat -- src/app.ts:120' }, 'Shell', opts), true);
});

test('P-04: a Shell command that touches no source file leaves it open', () => {
    const opts = { root: '/repo/app' };
    assert.equal(closes(READ_COUNT_GAP, { command: 'ls -la' }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: 'git status -s' }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: 'cat README.md' }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: 'cat .cursor/rules/core.law-gate.mdc' }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: 'cat /other/repo/src/index.ts' }, 'Shell', opts), false);
});

test('P-31: a source path inside a JSON payload is not an inspection', () => {
    /*
     * The false positive that would have paid P-04 with the wrong evidence: the path is data the
     * command never opened.
     */
    const opts = { root: '/repo/app' };
    assert.equal(closes(READ_COUNT_GAP, { command: `jq -r '.path' <<< '{"path":"src/app.mjs"}'` }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: `curl -s -d '{"file":"src/server.ts"}' http://localhost:8790/v1/x` }, 'Shell', opts), false);
    assert.equal(closes(READ_COUNT_GAP, { command: `echo '{"config":"src/config.json"}' >/dev/null` }, 'Shell', opts), false);
    // Naming a source file without reading it is not an inspection either.
    assert.equal(closes(READ_COUNT_GAP, { command: 'rm -rf src/app.mjs' }, 'Shell', opts), false);
});

/* ── P-28 · a preflight re-fire must not truncate the session's closure ─────────────────────── */

test('P-28: fineso — a refire keeps the rows closed under the previous preflight', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [
            { kind: 'law', query: 'harness-tooling' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ], { conversationId: 'conv-1' });

        recordGapToolUse('Read', { path: 'src/app.mjs' }, { root, tree: 'cursor' });
        const before = readClosure(root);
        assert.deepEqual(before.closedGapIds, ['code:need at least 1 file read(s); have 0']);

        // The next prompt submit re-runs preflight: new `at`, same conversation, same gaps.
        seedPreflight(root, [
            { kind: 'law', query: 'harness-tooling' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ], { conversationId: 'conv-1', at: '2026-10-23T04:07:15Z' });

        const after = recordGapToolUse('Read', { path: 'AGENTS.md' }, { root, tree: 'cursor' });
        assert.ok(
            after.closedGapIds.includes('code:need at least 1 file read(s); have 0'),
            'the measured wipe: 32 rows became 0 at the refire; a closed id must survive the new `at`',
        );
        assert.ok(after.toolUses.length >= 2, 'history is merged, not rebuilt');
        assert.equal(after.preflightAt, '2026-10-23T04:07:15Z', 'the file names the preflight it is measured against');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('P-28: a new gap the refire introduced is recorded as reopened, not as silent progress', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [{ kind: 'code', query: 'need at least 1 file read(s); have 0' }], {
            conversationId: 'conv-2',
        });
        recordGapToolUse('Read', { path: 'src/app.mjs' }, { root, tree: 'cursor' });

        seedPreflight(root, [
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
            { kind: 'law', query: 'harness-tooling' },
        ], { conversationId: 'conv-2', at: '2026-10-23T05:00:00Z' });

        const merged = mergeGapClosure({ at: '2026-10-23T05:00:00Z', conversationId: 'conv-2', gaps: [
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
            { kind: 'law', query: 'harness-tooling' },
        ] }, root, 'cursor');

        assert.deepEqual(merged.reopenedGapIds, ['law:harness-tooling']);
        assert.equal(merged.reopenedBy, 'preflight-refire');
        assert.equal(merged.allClosed, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('P-28: a different conversation does reset — that boundary is real', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [READ_COUNT_GAP], { conversationId: 'conv-old' });
        recordGapToolUse('Read', { path: 'src/app.mjs' }, { root, tree: 'cursor' });
        assert.equal(readClosure(root).closedGapIds.length, 1);

        seedPreflight(root, [READ_COUNT_GAP], { conversationId: 'conv-new', at: '2026-10-23T06:00:00Z' });
        const merged = mergeGapClosure({ at: '2026-10-23T06:00:00Z', conversationId: 'conv-new', gaps: [READ_COUNT_GAP] }, root, 'cursor');
        assert.deepEqual(merged.closedGapIds, [], 'a new conversation starts unmeasured');
        assert.deepEqual(merged.toolUses, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/* ── P-04 + P-28 end to end · the fineso turn shape ─────────────────────────────────────────── */

test('fineso scenario: a diagnostic turn can reach sufficient without a Read of project source', () => {
    const root = tempRoot();
    try {
        seedPreflight(root, [
            { kind: 'law', query: 'harness-tooling' },
            { kind: 'code', query: 'need at least 1 file read(s); have 0' },
        ]);
        // Law: the docgraph query the preflight itself asked for.
        recordGapToolUse('Shell', { command: 'docgraph --q "harness-tooling"' }, { root, tree: 'cursor' });
        // Code: a Shell inspection of a source file, not a Read tool call.
        const res = recordGapToolUse('Shell', { command: "sed -n '1,60p' packages/app/src/index.ts" }, { root, tree: 'cursor' });

        assert.equal(res.allClosed, true);
        const stamp = JSON.parse(fs.readFileSync(bundleStampPath(root, 'cursor'), 'utf8'));
        assert.equal(stamp.allowWrite, true);
        assert.equal(stamp.level, 'sufficient');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
