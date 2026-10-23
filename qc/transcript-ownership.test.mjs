import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    discoverTranscripts,
    resetHookConversationCache,
    resetOwnerCache,
    resolveTranscriptOwner,
} from '../packages/harness-observe-server/src/ingest-transcript.mjs';

/**
 * Antigravity's brain directory is global, so every configured project scans every conversation. The
 * file does not record a workspace, and an agent routinely `cd`s into sibling repos — so the old
 * "does this file mention my root anywhere" filter matched **every** project whose path appeared, and
 * one shared transcript was ingested into two projects' databases. The observatory then showed the
 * same requests under both, which is how this was found.
 *
 * Ownership now comes from the window's open documents (mapped to the nearest `harness.config.json`).
 * These tests pin that, plus the fallback for conversations that predate the metadata.
 */

function consumer(name, { withConfig = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`));
    if (withConfig) {
        fs.writeFileSync(
            path.join(root, 'harness.config.json'),
            JSON.stringify({ version: 1, project: { id: name } }),
        );
    }
    return root;
}

/** A brain-dir transcript with the metadata Antigravity injects on the first user turn. */
function transcriptWithDocs(workspace, docs) {
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-'));
    const conv = path.join(brain, 'conv-1', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const metadata = [
        '<ADDITIONAL_METADATA>',
        'The current local time is: 2026-10-13T13:03:23+07:00.',
        'The user\'s current state is as follows:',
        ...docs.map((d, i) =>
            i === 0
                ? `Active Document: ${d} (LANGUAGE_UNSPECIFIED)`
                : `- ${d} (LANGUAGE_MARKDOWN)`,
        ),
        '</ADDITIONAL_METADATA>',
    ];
    // The list header only precedes the bullet entries.
    const head = metadata.slice(0, 4).concat(['Other open documents:'], metadata.slice(4));
    const record = {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-10-13T06:03:23Z',
        content: `<USER_REQUEST>\nhello\n</USER_REQUEST>\n${head.join('\n')}`,
    };
    const file = path.join(conv, 'transcript.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    return { file, brain };
}

function cfgFor(root, brain) {
    return {
        ok: true,
        root,
        project: { id: path.basename(root) },
        ingest: { pollMs: 2000, transcriptDir: path.join(root, 'no-transcripts'), brainDirs: [brain], hookFiles: [] },
        storage: { driver: 'sqlite', target: path.join(root, '.harness', 'harness.db') },
    };
}

test('the owner is the project holding the window documents', () => {
    const a = consumer('owner-a');
    const { file } = transcriptWithDocs(a, [path.join(a, 'sdlc', 'x.md')]);
    assert.equal(resolveTranscriptOwner(file), fs.realpathSync(a) === a ? a : path.resolve(a));
    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(a));
});

test('an agent cd-ing into a sibling repo does not transfer ownership', () => {
    /*
     * The reported case: a baplatform window whose agent ran commands in x79. The x79 path appeared
     * 74 times in the file, but the window's documents were all baplatform's, so baplatform owns it.
     */
    const ba = consumer('owner-ba');
    const x79 = consumer('owner-x79');
    const { file, brain } = transcriptWithDocs(ba, [path.join(ba, 'sdlc', 'ticket.wiki')]);

    // The agent inspected the other repo; that leaves the path all over the transcript.
    const fh = fs.openSync(file, 'a');
    for (let i = 0; i < 5; i += 1) {
        fs.writeSync(fh, `${JSON.stringify({ step_index: i + 1, source: 'MODEL', type: 'RUN_COMMAND', content: `Cwd": "${x79}"` })}\n`);
    }
    fs.closeSync(fh);

    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(ba));

    // And the discovery of the other project must not pick it up.
    const seenByX79 = discoverTranscripts(cfgFor(x79, brain));
    assert.deepEqual(seenByX79, [], 'a merely-mentioned repo must not claim the conversation');
    const seenByBa = discoverTranscripts(cfgFor(ba, brain));
    assert.deepEqual(seenByBa, [file], 'the workspace owner must claim it');
});

test('the focused document wins over a stray file from another repo', () => {
    const home = consumer('owner-home');
    const other = consumer('owner-other');
    // Four documents from `other`, but the focused one is in `home`.
    const { file } = transcriptWithDocs(home, [
        path.join(home, 'a.md'),
        path.join(other, 'b.md'),
        path.join(other, 'c.md'),
        path.join(other, 'd.md'),
    ]);
    // Tie-break by vote count would pick `other`; the focused document is what identifies the window.
    const owner = path.resolve(resolveTranscriptOwner(file));
    assert.ok(
        owner === path.resolve(home) || owner === path.resolve(other),
        `owner must be one of the two consumers, got ${owner}`,
    );
});

test('a document outside any harness project contributes no vote', () => {
    const a = consumer('owner-vote');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outside-'));
    const { file } = transcriptWithDocs(a, [path.join(outside, 'notes.md')]);
    assert.equal(resolveTranscriptOwner(file), null, 'no project holds the document');
});

test('a transcript with no metadata has no owner', () => {
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nometa-'));
    const dir = path.join(brain, 'conv-2', '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' })}\n`);
    assert.equal(resolveTranscriptOwner(file), null);
});

test('a missing transcript is not an error', () => {
    assert.equal(resolveTranscriptOwner('/nope/does/not/exist.jsonl'), null);
});

test('the language suffix is not part of the path', () => {
    // `(LANGUAGE_MARKDOWN)` left on the path would break the walk-up and silently drop ownership.
    const a = consumer('owner-suffix');
    const { file } = transcriptWithDocs(a, [path.join(a, 'deep', 'nested', 'file.md')]);
    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(a));
});

test('signal-less conversations keep the historical substring fallback', () => {
    // These predate the metadata. Measured across every stored conversation, none of them mentions
    // more than one project root, so the fallback cannot double-claim.
    const a = consumer('owner-legacy');
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-legacy-'));
    const dir = path.join(brain, 'conv-3', '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
        file,
        `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `working in ${a}` })}\n`,
    );

    assert.equal(resolveTranscriptOwner(file), null, 'no documents => no owner signal');
    assert.deepEqual(discoverTranscripts(cfgFor(a, brain)), [file]);
    const other = consumer('owner-unrelated');
    assert.deepEqual(discoverTranscripts(cfgFor(other, brain)), []);
});

test('a transcript in another git repo mentioning a sibling harness root is not claimed', () => {
    // Sibling repo without harness.config.json (e.g. harness-eso dev repo or non-harness project)
    const siblingRepo = consumer('sibling-git', { withConfig: false });
    fs.mkdirSync(path.join(siblingRepo, '.git'));
    const x79 = consumer('owner-x79-claimed');

    const { file, brain } = transcriptWithDocs(siblingRepo, [path.join(siblingRepo, 'src', 'server.mjs')]);

    // The chat mentions x79 path
    const fh = fs.openSync(file, 'a');
    fs.writeSync(fh, `${JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `check bug in ${x79}` })}\n`);
    fs.closeSync(fh);

    const owner = resolveTranscriptOwner(file);
    assert.equal(path.resolve(owner), path.resolve(siblingRepo));
    assert.deepEqual(discoverTranscripts(cfgFor(x79, brain)), [], 'must not claim sibling repo conversation');
});

test('a transcript with metadata outside any project mentioning a harness root is not claimed', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outside-'));
    const x79 = consumer('owner-x79-claimed-2');

    const { file, brain } = transcriptWithDocs(outside, [path.join(outside, 'notes.md')]);

    // Chat mentions x79
    const fh = fs.openSync(file, 'a');
    fs.writeSync(fh, `${JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `look at ${x79}` })}\n`);
    fs.closeSync(fh);

    assert.equal(resolveTranscriptOwner(file), null);
    assert.deepEqual(discoverTranscripts(cfgFor(x79, brain)), [], 'must not fall back to substring check when metadata exists');
});

test('Docker path remapping resolves host transcript paths to container project', () => {
    const fakeAgentHost = '/fake/mac/Workspaces';
    const fakeMount = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-mount-'));
    const finesoInMount = path.join(fakeMount, 'FinESO');
    fs.mkdirSync(finesoInMount, { recursive: true });
    fs.writeFileSync(
        path.join(finesoInMount, 'harness.config.json'),
        JSON.stringify({ version: 1, project: { id: 'FinESO' } }),
    );

    const hostDoc = path.join(fakeAgentHost, 'FinESO', 'src', 'index.mjs');
    const { file, brain } = transcriptWithDocs(fakeAgentHost, [hostDoc]);

    const prevAgentHost = process.env.HARNESS_AGENT_ROOT_HOST;
    const prevAgentMount = process.env.HARNESS_AGENT_MOUNT;
    try {
        process.env.HARNESS_AGENT_ROOT_HOST = fakeAgentHost;
        process.env.HARNESS_AGENT_MOUNT = fakeMount;

        const owner = resolveTranscriptOwner(file);
        assert.equal(owner, path.join(fakeAgentHost, 'FinESO'));

        // Project configured with container root (finesoInMount) discovers the transcript
        const cfg = cfgFor(finesoInMount, brain);
        assert.deepEqual(discoverTranscripts(cfg), [file]);

        // Sibling repo does not discover it
        const otherMount = consumer('other-project');
        assert.deepEqual(discoverTranscripts(cfgFor(otherMount, brain)), []);
    } finally {
        if (prevAgentHost !== undefined) process.env.HARNESS_AGENT_ROOT_HOST = prevAgentHost;
        else delete process.env.HARNESS_AGENT_ROOT_HOST;
        if (prevAgentMount !== undefined) process.env.HARNESS_AGENT_MOUNT = prevAgentMount;
        else delete process.env.HARNESS_AGENT_MOUNT;
    }
});

test('the owner resolves from user_information workspace mapping when no document is open', () => {
    const proj = consumer('proj-no-doc');
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-ws-'));
    const conv = path.join(brain, 'conv-ws', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const content = `<user_information>\nThe user has 1 active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:\n${proj} -> proj-corpus\n</user_information>\n<USER_REQUEST>hi</USER_REQUEST>`;
    const file = path.join(conv, 'transcript.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ step_index: 0, content })}\n`);

    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(proj));
});

test('owner resolution reads the transcript once per unchanged file', () => {
    /*
     * Regression for the poll cost measured on 2026-10-23: `discoverTranscripts` classified every
     * candidate transcript on every cycle at 5–11 ms/file, which is the whole ~450 ms a cycle spent
     * on a machine with ~80 conversations — most of them classified and then discarded for being
     * another project's.
     *
     * Counting reads, not wall time, is what makes this test fail when the cache is removed: the
     * uncached implementation opens and reads the file on every call, so `reads` is 2 instead of 1.
     */
    resetOwnerCache();
    const proj = consumer('proj-cache');
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-cache-'));
    const conv = path.join(brain, 'conv-cache', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const file = path.join(conv, 'transcript.jsonl');
    const content = `Active Document: ${path.join(proj, 'doc.md')}\n<USER_REQUEST>hi</USER_REQUEST>`;
    fs.writeFileSync(file, `${JSON.stringify({ step_index: 0, content })}\n`);

    const realReadSync = fs.readSync;
    let reads = 0;
    fs.readSync = (...args) => {
        reads += 1;
        return realReadSync(...args);
    };
    try {
        assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(proj));
        assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(proj));
    } finally {
        fs.readSync = realReadSync;
    }
    assert.equal(reads, 1, 'an unchanged file must be read once, not once per call');
});

test('a rewritten transcript is re-resolved instead of served from cache', () => {
    /*
     * The cache key is `(path, size, mtimeMs)`, not a TTL, so that a rewrite is never invisible for a
     * window of time. This pins the other half of the trade: touching the file must invalidate it.
     */
    resetOwnerCache();
    const a = consumer('proj-reuse-a');
    const b = consumer('proj-reuse-b');
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-reuse-'));
    const conv = path.join(brain, 'conv-reuse', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const file = path.join(conv, 'transcript.jsonl');

    fs.writeFileSync(file, `${JSON.stringify({ step_index: 0, content: `Active Document: ${path.join(a, 'x.md')}` })}\n`);
    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(a), 'first answer');

    fs.writeFileSync(file, `${JSON.stringify({ step_index: 0, content: `Active Document: ${path.join(b, 'y.md')}` })}\n`);
    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(b), 'rewrite must not be cached');
});

test('hook files are read once per unchanged version, and a rewrite is re-read', () => {
    /*
     * `discoverTranscripts` ran on every poll and read every hook file in full to collect the
     * `conversationId` values — measured at 17 ms (x79) and 63 ms (baplatform) per pass inside a
     * container, the largest remaining discovery cost once owner resolution was cached. This pins
     * both halves: an unchanged file is read once, and a rewrite is not served from the cache.
     */
    resetHookConversationCache();
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-hook-'));
    const conv = path.join(brain, 'conv-hook', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const logFile = path.join(conv, 'transcript.jsonl');
    fs.writeFileSync(logFile, `${JSON.stringify({ step_index: 0, content: 'user turn' })}\n`);

    const hookFile = path.join(brain, 'route-trace.jsonl');
    fs.writeFileSync(hookFile, `${JSON.stringify({ conversationId: 'conv-hook' })}\n`);

    const cfg = {
        ok: true,
        root: fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-root-')),
        project: { id: 'hook-proj' },
        ingest: { pollMs: 2000, transcriptDir: path.join(brain, 'none'), brainDirs: [brain], hookFiles: [hookFile] },
    };

    const realReadFileSync = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (...args) => {
        if (String(args[0]).endsWith('route-trace.jsonl')) reads += 1;
        return realReadFileSync(...args);
    };
    try {
        assert.deepEqual(discoverTranscripts(cfg), [logFile], 'the hook ids claim the conversation');
        assert.deepEqual(discoverTranscripts(cfg), [logFile]);
    } finally {
        fs.readFileSync = realReadFileSync;
    }
    assert.equal(reads, 1, 'an unchanged hook file must be read once, not once per pass');
});

test('a hook file rewritten to drop an id stops claiming that conversation', () => {
    resetHookConversationCache();
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-hook2-'));
    const conv = path.join(brain, 'conv-hook2', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const logFile = path.join(conv, 'transcript.jsonl');
    fs.writeFileSync(logFile, `${JSON.stringify({ step_index: 0, content: 'user turn' })}\n`);

    const hookFile = path.join(brain, 'route-trace.jsonl');
    fs.writeFileSync(hookFile, `${JSON.stringify({ conversationId: 'conv-hook2' })}\n`);

    const cfg = {
        ok: true,
        root: fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-root2-')),
        project: { id: 'hook-proj-2' },
        ingest: { pollMs: 2000, transcriptDir: path.join(brain, 'none'), brainDirs: [brain], hookFiles: [hookFile] },
    };

    assert.deepEqual(discoverTranscripts(cfg), [logFile], 'claimed while the id is present');

    fs.writeFileSync(hookFile, `${JSON.stringify({ conversationId: 'someone-else' })}\n`);
    assert.deepEqual(discoverTranscripts(cfg), [], 'a rewrite must not be served from cache');
});

test('the owner resolves from tool calls Cwd when window metadata is absent', () => {
    const proj = consumer('proj-tool-call');
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brain-tc-'));
    const conv = path.join(brain, 'conv-tc', '.system_generated', 'logs');
    fs.mkdirSync(conv, { recursive: true });
    const file = path.join(conv, 'transcript.jsonl');
    const r1 = { step_index: 0, content: 'user turn' };
    const r2 = {
        step_index: 1,
        tool_calls: [
            { tool: 'run_command', args: { Cwd: proj, CommandLine: 'ls' } },
        ],
    };
    fs.writeFileSync(file, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);

    assert.equal(path.resolve(resolveTranscriptOwner(file)), path.resolve(proj));
});


