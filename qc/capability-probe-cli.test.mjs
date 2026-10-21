import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCapabilityReport } from '../packages/harness-cli/src/capability-probe-cmd.mjs';

function consumerWithMemoryPolicy(extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-probe-'));
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            eso: {
                sources: {
                    memory: { enabled: true, prefer: ['native'], fallback: ['agentmemory-mcp', 'none'] },
                    ...extra,
                },
            },
        }),
    );
    return root;
}

test('the CLI report shows the native provider when a host shim supplies one', () => {
    const root = consumerWithMemoryPolicy();
    const native = { id: 'native:dsh-session', kinds: ['memory'], capability: 'native', ceiling: 0.65, async fetch() { return { snippets: [] }; } };
    const report = buildCapabilityReport(root, { extraProviders: [native] });
    const memory = report.kinds.find((k) => k.kind === 'memory');

    assert.equal(report.policyFromFile, true);
    assert.equal(memory.selected.id, 'native:dsh-session');
    assert.equal(memory.reason, 'native');
});

test('the same policy falls back to the external provider without a shim', () => {
    const root = consumerWithMemoryPolicy();
    const report = buildCapabilityReport(root);
    const memory = report.kinds.find((k) => k.kind === 'memory');

    assert.equal(memory.selected.id, 'agentmemory-mcp');
    assert.equal(memory.reason, 'id:agentmemory-mcp');
});

test('legacy law configuration still reports docgraph', () => {
    const root = consumerWithMemoryPolicy();
    const report = buildCapabilityReport(root);
    const law = report.kinds.find((k) => k.kind === 'law');

    assert.equal(law.selected.id, 'docgraph-cli');
    // The foundation default names no adapter, so the first capable builtin wins and the probe says so.
    assert.equal(law.reason, 'default');
});
