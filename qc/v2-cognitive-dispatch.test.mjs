import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    extractNormativeSpec,
    filterMemoryHits,
    extractPinnedInvariants,
    buildPreflightProjection,
} from '@mu/harness-eso-core';
import { adapter as agentMemoryAdapter } from '../packages/harness-eso-core/adapters/agentmemory-memory.mjs';
import { adapter as docgraphAdapter } from '../packages/harness-eso-core/adapters/docgraph-law.mjs';

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

function tempConsumer(policyOverrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cognitive-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'session'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'test-cognitive' } }),
    );
    const policy = {
        version: 1,
        jev: { mode: 'off' },
        eso: {
            enabled: true,
            mode: 'hint',
            enforceWrites: 'fail_closed',
            thresholds: { T_low: 0.45, T_high: 0.72 },
            sources: { law: { enabled: false }, code: { enabled: false }, memory: { enabled: false } },
            ...policyOverrides,
        },
    };
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify(policy, null, 2),
    );
    /*
     * The packs this fixture needs, declared the way a real consumer declares them.
     *
     * These used to come from a built-in table inside eso-core, which meant every consumer inherited
     * one repository's law terms whether or not those documents existed there (G-01). The table is
     * gone, so a fixture that wants a strict `tools` pack has to say so — which is also the only way a
     * test can prove the manifest is actually read.
     */
    fs.writeFileSync(
        path.join(root, '.harness', 'skill-packs.json'),
        JSON.stringify({
            version: 1,
            packs: {
                tools: {
                    description: 'harness tooling work',
                    requiredDocTerms: ['harness-tooling', 'decision-facade'],
                    minReadPaths: 1,
                    lawQueries: ['harness-tooling'],
                },
            },
        }, null, 2),
    );
    return root;
}

test('Docgraph Normative Slicing extracts invariants and alerts while dropping prose', () => {
    const rawMarkdown = `
# System Architecture

This is a long introductory text describing background lore, history, and casual remarks
that should never bloat the context window during execution. We had a meeting last week
about how databases work and someone suggested using MongoDB.

## Invariants
- **INV-001**: System must always validate project isolation before write operations.
- **INV-002**: Ledger entries are strictly append-only.

Here is some additional discursive discussion explaining the history behind INV-001.

> [!CRITICAL]
> Do not bypass the security proxy under any circumstances.

More conversational concluding thoughts here.
`;

    const { text, specDebt } = extractNormativeSpec(rawMarkdown, 1000);
    assert.equal(specDebt, false);
    assert.ok(text.includes('INV-001'));
    assert.ok(text.includes('INV-002'));
    assert.ok(text.includes('[!CRITICAL]'));
    assert.ok(!text.includes('discursive discussion'));
    assert.ok(!text.includes('MongoDB'));
});

test('Docgraph Normative Slicing gracefully falls back with specDebt=true on legacy doc', () => {
    const legacyDoc = `
# Old Style Document
This document has no invariants section, no alerts, just arbitrary prose from 2021.
It mentions some config keys like api_key and port 8080.
`;
    const { text, specDebt } = extractNormativeSpec(legacyDoc, 1000);
    assert.equal(specDebt, true);
    assert.ok(text.includes('Old Style Document'));
    assert.ok(text.includes('8080'));
});

test('AgentMemory Delta-Scoping filters out records matching current session ID', () => {
    const currentSession = 'session-current-42';
    const hits = [
        { id: 1, sessionId: 'session-current-42', content: 'Current turn draft notes' },
        { id: 2, sessionId: 'session-past-01', content: 'Operator preference: use Bun' },
        { id: 3, conversation_id: 'session-current-42', content: 'Recent chat message' },
        { id: 4, conversationId: 'session-other-99', content: 'Crucial architectural rule' },
    ];

    const filtered = filterMemoryHits(hits, { excludeSessionId: currentSession });
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, 2);
    assert.equal(filtered[1].id, 4);
});

test('AgentMemory Delta-Scoping filters by tier when requested', () => {
    const hits = [
        { id: 1, tier: 'preference', content: 'Prefers dark mode' },
        { id: 2, tier: 'rule', content: 'Never commit secrets' },
        { id: 3, tier: 'fact', content: 'Repo is on main branch' },
    ];

    const filtered = filterMemoryHits(hits, { tier: 'rule' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 2);
});

test('AgentMemory adapter fetch passes excludeSessionId and filters current session', async () => {
    const mockHits = [
        { id: 'm1', sessionId: 'sess-abc', content: 'Self echo from this session' },
        { id: 'm2', sessionId: 'sess-xyz', content: 'Past rule: follow TDD quartet' },
    ];

    let requestBody;
    const mockFetch = async (url, opts) => {
        requestBody = JSON.parse(opts.body);
        return {
            ok: true,
            json: async () => ({ memories: mockHits }),
        };
    };

    const res = await agentMemoryAdapter.fetch('testing query', {
        conversationId: 'sess-abc',
        fetchImpl: mockFetch,
        policy: { eso: { sources: { memory: { adapter: 'agentmemory-mcp' } } } },
    });

    assert.equal(requestBody.excludeSessionId, 'sess-abc');
    assert.equal(res.snippets.length, 1);
    assert.ok(res.snippets[0].text.includes('Past rule: follow TDD quartet'));
    assert.ok(!res.snippets[0].text.includes('Self echo'));
});

test('Preflight Hook: HOT turn emits continuation=true, cognitiveState=HOT, and 0 additional_context', () => {
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    const prompt = 'Add new feature for billing invoice service';
    const convId = 'session-hot-turn-01';

    // First call: initial turn
    const res1 = runHook('preflight', {
        conversationId: convId,
        prompt,
        invocationNum: 0,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res1.status, 0);
    const preflight1Path = path.join(root, '.cursor', 'session', '.eso-preflight.json');
    assert.ok(fs.existsSync(preflight1Path));
    const preflight1 = JSON.parse(fs.readFileSync(preflight1Path, 'utf8'));
    assert.ok(preflight1.fingerprint);

    // Second call: exact same prompt, same session, unmodified workspace
    const res2 = runHook('preflight', {
        conversationId: convId,
        prompt,
        invocationNum: 1,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res2.status, 0);
    assert.equal(res2.json.esoPreflight?.continuation, true);
    assert.equal(res2.json.esoPreflight?.cognitiveState, 'HOT');
    assert.equal(res2.json.additional_context, undefined);
});

test('extractPinnedInvariants parses INV-* codes from law snippets', () => {
    const turnResult = {
        retrieval: {
            snippets: [
                {
                    kind: 'law',
                    text: 'Security Rules:\n- **INV-AUTH**: Check user auth\n- **INV-DB-02**: Read before write',
                },
                {
                    kind: 'memory',
                    text: 'Some memory snippet',
                },
            ],
        },
    };

    const pinned = extractPinnedInvariants(turnResult);
    assert.deepEqual(pinned, ['INV-AUTH', 'INV-DB-02']);
});

test('buildPreflightProjection labels cognitiveState=WARM when sufficient and extracts pinned invariants', () => {
    const turn = {
        turnId: 't-1',
        conversationId: 'c-1',
        fingerprint: 'fp-123',
    };
    const turnResult = {
        verdict: { level: 'sufficient' },
        measure: { score: 0.95 },
        collected: {
            retrieval: {
                snippets: [
                    {
                        kind: 'law',
                        text: '- **INV-ESO-01**: Never bypass preflight checks',
                    },
                ],
            },
        },
    };

    const projection = buildPreflightProjection(turn, turnResult, {});
    assert.equal(projection.cognitiveState, 'WARM');
    assert.deepEqual(projection.pinnedInvariants, ['INV-ESO-01']);
});

test('Gate G1: short stem (< 6 chars) does not short-circuit to HOT even if index clean', () => {
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });

    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            at: new Date().toISOString(),
            conversationId: 'sess-g1',
            userQueryStem: 'ok',
            fingerprint: 'some-valid-fp',
            level: 'sufficient',
            score: 1.0,
        }),
    );

    const res = runHook('preflight', {
        conversationId: 'sess-g1',
        prompt: 'ok',
        invocationNum: 1,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res.status, 0);
    assert.notEqual(res.json.esoPreflight?.cognitiveState, 'HOT');
});

test('Gate G2: missing fingerprint on disk fails closed (no HOT short-circuit)', () => {
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });

    fs.writeFileSync(
        path.join(root, '.cursor', 'session', '.eso-preflight.json'),
        JSON.stringify({
            at: new Date().toISOString(),
            conversationId: 'sess-g2',
            userQueryStem: 'valid meaningful stem',
            level: 'sufficient',
            score: 1.0,
        }),
    );

    const res = runHook('preflight', {
        conversationId: 'sess-g2',
        prompt: 'valid meaningful stem',
        invocationNum: 1,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res.status, 0);
    assert.notEqual(res.json.esoPreflight?.cognitiveState, 'HOT');
});

test('Preflight Hook: a root prompt with sources off needs no evidence at all (G-01)', () => {
    /*
     * The intent of this fixture was "nothing was measured, so say so". After G-01 that is two cases,
     * and they must not be confused: with no `sources` declared nothing is fetched, the `root` pack
     * requires nothing, and the honest verdict is **sufficient** — the old assertion was pinning the
     * defect, which reported `insufficient` for a turn that owed no evidence. The `Gaps:`-less
     * directive is still emitted when the turn is genuinely missing something, which the test after
     * this one covers.
     */
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });

    const res = runHook('preflight', {
        conversationId: 'sess-cold',
        prompt: 'Refactor accounting ledger subsystem',
        invocationNum: 0,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res.status, 0);
    assert.equal(res.json.esoPreflight?.level, 'sufficient');
    assert.equal(res.json.additional_context?.includes('[ESO EVIDENCE GAP -'), false);
});

test('Preflight Hook: a prompt that names code still gets the COLD gap directive', () => {
    // `packages/harness-…` routes to the `tools` bucket, whose pack this fixture **declares** in
    // `.harness/skill-packs.json` (the product no longer ships one). It demands a read and two law
    // documents. The fixture has no law index, so the directive must appear and must name the terms
    // nothing can answer (G-02).
    const root = tempConsumer();
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });

    const res = runHook('preflight', {
        conversationId: 'sess-cold-tools',
        prompt: 'fix packages/harness-eso-core/src/gate.mjs',
        invocationNum: 0,
    }, { cwd: root, tree: 'cursor' });

    assert.equal(res.status, 0);
    assert.ok(res.json.additional_context?.includes('[ESO EVIDENCE GAP -'), res.json.additional_context);
});

