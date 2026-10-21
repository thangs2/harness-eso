import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceRegistry } from '../packages/harness-eso-core/src/adapter-registry.mjs';
import { probeCapabilities } from '../packages/harness-eso-core/src/capability-probe.mjs';

const native = { id: 'native:dsh-session', kinds: ['memory'], capability: 'native', ceiling: 0.65, async fetch() { return { snippets: [] }; } };
const external = { id: 'agentmemory-mcp', kinds: ['memory'], capability: 'external', async fetch() { return { snippets: [] }; } };

test('the probe explains the selection and lists the alternatives', () => {
    const policy = { eso: { sources: { memory: { enabled: true, prefer: ['native'], fallback: ['agentmemory-mcp'] } } } };
    const registry = createSourceRegistry(policy, [native, external]);
    const [memory] = probeCapabilities(registry, ['memory']);

    assert.equal(memory.selected.id, 'native:dsh-session');
    assert.equal(memory.reason, 'native');
    assert.equal(memory.selected.ceiling, 0.65);
    assert.deepEqual(
        memory.candidates.map((c) => [c.id, c.selected]),
        [
            ['noop-memory', false],
            ['agentmemory-mcp', false],
            ['native:dsh-session', true],
        ],
        'one row per id, including the noop and the builtin it overrides',
    );
});

test('the probe reports a fallback instead of hiding it', () => {
    const policy = { eso: { sources: { memory: { enabled: true, prefer: ['native'], fallback: ['agentmemory-mcp'] } } } };
    const registry = createSourceRegistry(policy, [native, external], { health: (p) => p.id !== 'native:dsh-session' });
    const [memory] = probeCapabilities(registry, ['memory']);

    assert.equal(memory.selected.id, 'agentmemory-mcp');
    assert.equal(memory.reason, 'id:agentmemory-mcp');
});

test('an unconfigured kind reports none rather than an empty object', () => {
    const registry = createSourceRegistry({ eso: { sources: { memory: { enabled: false } } } });
    const [memory] = probeCapabilities(registry, ['memory']);
    assert.equal(memory.selected, null);
    assert.equal(memory.reason, 'disabled');
});
