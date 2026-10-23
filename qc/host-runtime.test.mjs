import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostRuntime } from '../packages/harness-eso-core/src/host-runtime.mjs';

import { nativeMemoryProvider, policyWithNativeMemory } from './fixtures/host-runtime-fixture.mjs';

test('the host runtime forwards its providers into preflight', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-'));
    const runtime = createHostRuntime({ root, policy: policyWithNativeMemory(), providers: [nativeMemoryProvider()] });

    const out = await runtime.preflight({ event: 'turn_start', userQueryStem: 'project id', turnId: 't1' });
    assert.equal(out.skipped, false);
    assert.ok(out.retrieval.snippets.some((s) => s.text.includes('project id')), 'native evidence reached the engine');
    assert.ok(out.retrieval.trace.some((line) => line.includes('native:test-memory')), 'the provider trace is recorded');
});

test('the probe explains the native binding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-'));
    const runtime = createHostRuntime({ root, policy: policyWithNativeMemory(), providers: [nativeMemoryProvider()] });
    const memory = runtime.probe().find((row) => row.kind === 'memory');
    assert.equal(memory.selected.id, 'native:test-memory');
    assert.equal(memory.reason, 'native');
});

test('without a provider the same policy falls through to none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-'));
    const runtime = createHostRuntime({ root, policy: policyWithNativeMemory() });
    const out = await runtime.preflight({ event: 'turn_start', userQueryStem: 'project id', turnId: 't2' });
    assert.equal(out.retrieval.snippets.length, 0);
});
