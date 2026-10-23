import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDshEsoPlugin } from '../packages/harness-host-dsh/src/plugin.mjs';
import { policyWithNativeMemory } from './fixtures/host-runtime-fixture.mjs';

test('the DSH plugin registers session memory as a native provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-plugin-'));
    const plugin = createDshEsoPlugin({
        root,
        policy: policyWithNativeMemory(),
        searchEvents: async () => [{ text: 'approval policy is per project', seq: 3, sessionId: 's-1' }],
    });

    const memory = plugin.probe().find((row) => row.kind === 'memory');
    assert.equal(memory.selected.id, 'native:dsh-session');
    assert.equal(memory.selected.capability, 'native');

    const out = await plugin.preflight({ event: 'turn_start', userQueryStem: 'approval', turnId: 't1' });
    assert.ok(out.retrieval.snippets.some((s) => s.text.includes('per project')));
    assert.equal(out.retrieval.snippets[0].provenance.sessionSeq, 3);
});

test('without a host search function the plugin does not invent memory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-plugin-'));
    const plugin = createDshEsoPlugin({ root, policy: policyWithNativeMemory() });
    const memory = plugin.probe().find((row) => row.kind === 'memory');
    assert.equal(memory.selected, null);
    assert.equal(memory.reason, 'none');
});

test('the plugin registers the host skills as a native law provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-plugin-law-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n\nIsolation is mandatory for every query.\n');
    const policy = policyWithNativeMemory();
    policy.eso.sources.law = { enabled: true, prefer: ['native'], fallback: ['none'] };
    policy.eso.sources.memory = { enabled: false };

    const plugin = createDshEsoPlugin({ root, policy });
    const law = plugin.probe().find((row) => row.kind === 'law');
    assert.equal(law.selected.id, 'native:dsh-skills');
    assert.equal(law.reason, 'native');

    /*
     * Law queries come from the prompt-class pack, not from the user's stem, so this test asserts the
     * binding rather than a particular snippet: the provider is selected and exposed to COLLECT.
     */
    assert.equal(plugin.runtime.registry.resolve('law').id, 'native:dsh-skills');
    const out = await plugin.preflight({ event: 'turn_start', userQueryStem: 'project isolation', turnId: 't1' });
    assert.equal(out.skipped, false);
    assert.ok(Array.isArray(out.retrieval.trace));
});
