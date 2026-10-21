import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshSessionMemory } from '../packages/harness-host-dsh/src/memory-provider.mjs';

test('the DSH memory provider refuses to exist without a host query function', () => {
    assert.throws(() => createDshSessionMemory({}), /searchEvents must be a function/);
});

test('an empty query does not call the host', async () => {
    let called = 0;
    const provider = createDshSessionMemory({ searchEvents: async () => (called += 1, []) });
    const out = await provider.fetch('   ', {});
    assert.deepEqual(out.snippets, []);
    assert.equal(called, 0);
    assert.match(out.trace, /skip-empty/);
});

test('session hits become evidence with provenance', async () => {
    const seen = [];
    const provider = createDshSessionMemory({
        searchEvents: async (q) => {
            seen.push(q);
            return [
                { text: 'tenant id must be explicit', score: 0.8, seq: 42, sessionId: 's-1' },
                { snippet: 'approval policy is per tenant', seq: 43, sessionId: 's-1' },
                { text: '', seq: 44 },
            ];
        },
        limit: 5,
    });

    const out = await provider.fetch('tenant', { conversationId: 's-1', root: '/repo' });
    assert.equal(out.snippets.length, 2, 'a hit without text is not evidence');
    assert.equal(out.snippets[0].provenance.sessionSeq, 42);
    assert.equal(out.snippets[0].provenance.sessionId, 's-1');
    assert.equal(out.snippets[1].text, 'approval policy is per tenant');
    assert.equal(seen[0].sessionId, 's-1');
    assert.equal(seen[0].cwd, '/repo');
    assert.equal(provider.capability, 'native');
    assert.ok(provider.ceiling < 1, 'session recall must not claim full coverage');
});
