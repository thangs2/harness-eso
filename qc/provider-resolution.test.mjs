import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceRegistry } from '../packages/harness-eso-core/src/adapter-registry.mjs';

const nativeMemory = { id: 'native-memory', kinds: ['memory'], capability: 'native', async fetch() { return { snippets: [] }; } };
const externalMemory = { id: 'external-memory', kinds: ['memory'], async fetch() { return { snippets: [] }; } };

const withMemory = (memory) => ({ eso: { sources: { memory } } });

test('legacy adapter id keeps resolving exactly as before', () => {
    const registry = createSourceRegistry({ eso: { sources: { law: { adapter: 'docgraph-cli', enabled: true } } } });
    assert.equal(registry.resolve('law').id, 'docgraph-cli');
    assert.equal(registry.resolveWithReason('law').reason, 'id:docgraph-cli');
});

test('a provider chain prefers the native capability', () => {
    const registry = createSourceRegistry(
        withMemory({ enabled: true, prefer: ['native'], fallback: ['external-memory', 'none'] }),
        [nativeMemory, externalMemory],
    );
    const picked = registry.resolveWithReason('memory');
    assert.equal(picked.adapter.id, 'native-memory');
    assert.equal(picked.reason, 'native');
});

test('an unhealthy native source falls through to the next provider', () => {
    const registry = createSourceRegistry(
        withMemory({ enabled: true, prefer: ['native'], fallback: ['external-memory'] }),
        [nativeMemory, externalMemory],
        { health: (provider) => provider.id !== 'native-memory' },
    );
    const picked = registry.resolveWithReason('memory');
    assert.equal(picked.adapter.id, 'external-memory');
    assert.equal(picked.reason, 'id:external-memory');
});

test('fallback none means no provider, and says so', () => {
    const registry = createSourceRegistry(withMemory({ enabled: true, prefer: ['native'], fallback: ['none'] }), [externalMemory]);
    const picked = registry.resolveWithReason('memory');
    assert.equal(picked.adapter, null);
    assert.equal(picked.reason, 'none');
});

test('a disabled source never resolves', () => {
    const registry = createSourceRegistry(withMemory({ enabled: false, prefer: ['external-memory'] }), [externalMemory]);
    assert.equal(registry.resolve('memory'), null);
    assert.equal(registry.resolveWithReason('memory').reason, 'disabled');
});

test('a misspelled explicit id fails visibly instead of falling back', () => {
    const registry = createSourceRegistry({ eso: { sources: { law: { adapter: 'docgraph-clii', enabled: true } } } });
    const picked = registry.resolveWithReason('law');
    assert.equal(picked.adapter, null, 'a typo must not silently select a different provider');
    assert.equal(picked.reason, 'exhausted');
});

test('memory is never switched on by the implicit default', () => {
    /*
     * Before the registry owned selection, every memory adapter self-gated on `adapter`, so an
     * unconfigured consumer resolved to null. Moving selection into the registry must not quietly
     * enable agentmemory just because the provider exists.
     */
    const registry = createSourceRegistry({ eso: { sources: { memory: { enabled: true } } } });
    assert.equal(registry.resolve('memory'), null);
    assert.equal(registry.resolveWithReason('memory').reason, 'none');
});
