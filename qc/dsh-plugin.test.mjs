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
        searchEvents: async () => [{ text: 'approval policy is per tenant', seq: 3, sessionId: 's-1' }],
    });

    const memory = plugin.probe().find((row) => row.kind === 'memory');
    assert.equal(memory.selected.id, 'native:dsh-session');
    assert.equal(memory.selected.capability, 'native');

    const out = await plugin.preflight({ event: 'turn_start', userQueryStem: 'approval', turnId: 't1' });
    assert.ok(out.retrieval.snippets.some((s) => s.text.includes('per tenant')));
    assert.equal(out.retrieval.snippets[0].provenance.sessionSeq, 3);
});

test('without a host search function the plugin does not invent memory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-plugin-'));
    const plugin = createDshEsoPlugin({ root, policy: policyWithNativeMemory() });
    const memory = plugin.probe().find((row) => row.kind === 'memory');
    assert.equal(memory.selected, null);
    assert.equal(memory.reason, 'none');
});
