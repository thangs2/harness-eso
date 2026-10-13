import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    discoverTranscripts,
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
