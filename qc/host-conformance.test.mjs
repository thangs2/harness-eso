import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runHostConformance } from '../packages/harness-eso-core/src/conformance.mjs';

function fixture({ preflight = true, trace = true, hooks = true, pack = true, invalidPreflight = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-conf-'));
    fs.mkdirSync(path.join(root, '.harness', 'host-pack'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    if (pack) fs.writeFileSync(path.join(root, '.harness', 'host-pack', 'harness-hook.mjs'), '// pack');
    if (hooks) {
        fs.writeFileSync(
            path.join(root, '.cursor', 'hooks.json'),
            JSON.stringify({
                hooks: {
                    preToolUse: [
                        { command: 'node .harness/host-pack/harness-hook.mjs --hook guard-shell --tree cursor' },
                    ],
                },
            }),
        );
    }
    if (preflight) {
        fs.writeFileSync(
            path.join(root, '.cursor', 'session', '.eso-preflight.json'),
            invalidPreflight ? '{not json' : JSON.stringify({ level: 'sufficient', score: 1, at: '2026-10-21T10:00:00Z' }),
        );
    }
    if (trace) fs.writeFileSync(path.join(root, '.cursor', 'session', 'route-trace.jsonl'), '{"event":"preInvocation"}\n');
    return root;
}

test('a fully wired consumer reaches H3 and stops before the native tier', () => {
    const report = runHostConformance(fixture());
    assert.equal(report.ok, true);
    assert.equal(report.tierReached, 'H3');
    assert.equal(report.tiers.find((t) => t.id === 'H4').status, 'skip');
});

test('H4 is optional unless the run requires a native provider', () => {
    const probe = [{ kind: 'memory', selected: { id: 'agentmemory-mcp', capability: 'external' } }];
    const optional = runHostConformance(fixture(), { probe });
    assert.equal(optional.tiers.find((t) => t.id === 'H4').status, 'skip');
    assert.equal(optional.tierReached, 'H3');

    const strict = runHostConformance(fixture(), { probe, requireNative: true });
    assert.equal(strict.tiers.find((t) => t.id === 'H4').status, 'fail');
});

test('a native provider bound by a shim reaches H4', () => {
    const probe = [{ kind: 'memory', selected: { id: 'native:dsh-session', capability: 'native' } }];
    const report = runHostConformance(fixture(), { probe });
    assert.equal(report.tierReached, 'H4');
    assert.equal(report.tiers.find((t) => t.id === 'H4').status, 'pass');
});

test('an empty consumer fails at H0 and claims no tier', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-conf-empty-'));
    const report = runHostConformance(root);
    assert.equal(report.ok, false);
    assert.equal(report.tierReached, '-');
    assert.equal(report.tiers.find((t) => t.id === 'H0').status, 'fail');
});

test('a broken preflight file fails H2 instead of counting as evidence', () => {
    const report = runHostConformance(fixture({ invalidPreflight: true }));
    assert.equal(report.tiers.find((t) => t.id === 'H2').status, 'fail');
    assert.equal(report.tierReached, 'H1');
});

test('hooks without the pack stop at H0-H1', () => {
    const report = runHostConformance(fixture({ pack: false }));
    assert.equal(report.tiers.find((t) => t.id === 'H1').status, 'fail');
    assert.equal(report.tierReached, 'H0');
});
