import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runHostConformance } from '../packages/harness-eso-core/src/conformance.mjs';

function fixture({
    preflight = true,
    trace = true,
    hooks = true,
    pack = true,
    invalidPreflight = false,
    codex = false,
    surface = null,
    /*
     * Defaults describe a host provisioned *before* its last preflight ran, which is every healthy
     * consumer. Pinning both keeps the suite independent of the clock: the pack is written with its
     * mtime set, never with "now".
     */
    packMtime = '2026-10-20T09:00:00Z',
    preflightAt = '2026-10-21T10:00:00Z',
    preflightLevel = 'sufficient',
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-conf-'));
    fs.mkdirSync(path.join(root, '.harness', 'host-pack'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor', 'session'), { recursive: true });
    if (pack) {
        const packFile = path.join(root, '.harness', 'host-pack', 'harness-hook.mjs');
        fs.writeFileSync(packFile, '// pack');
        if (packMtime) {
            const seconds = Math.floor(Date.parse(packMtime) / 1000);
            fs.utimesSync(packFile, seconds, seconds);
        }
    }
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
    if (codex) {
        fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.codex', 'hooks.json'),
            JSON.stringify({
                hooks: {
                    PreToolUse: [
                        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .harness/host-pack/harness-hook.mjs --hook guard-shell --tree codex' }] },
                    ],
                },
            }),
        );
    }
    if (surface) {
        fs.writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify({ harnessSurface: surface }));
    }
    if (preflight) {
        fs.writeFileSync(
            path.join(root, '.cursor', 'session', '.eso-preflight.json'),
            invalidPreflight ? '{not json' : JSON.stringify({ level: preflightLevel, score: 1, at: preflightAt }),
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

/*
 * G-19. Atrievefin, 2026-10-23: the pack was refreshed at 14:29 UTC with the new guards, and
 * `verify host` still reported `PASS H2  …: insufficient at 2026-10-23T11:21:18Z` — a verdict
 * written by the previous pack, ten hours earlier. H2 asked "is there a verdict", never "is it this
 * build's verdict", so the probe reported the past as the present. These two cases pin both sides.
 */
test('G-19: a preflight verdict older than the installed pack fails H2', () => {
    const report = runHostConformance(
        fixture({ packMtime: '2026-10-23T14:29:30Z', preflightAt: '2026-10-23T11:21:18Z', preflightLevel: 'insufficient' }),
    );
    const h2 = report.tiers.find((t) => t.id === 'H2');
    assert.equal(h2.status, 'fail');
    assert.match(h2.detail, /predates the installed pack/);
    assert.equal(report.tierReached, 'H1');
    assert.equal(report.ok, false);
});

test('G-19: a preflight verdict written after the pack install still passes H2', () => {
    const report = runHostConformance(
        fixture({ packMtime: '2026-10-23T14:29:30Z', preflightAt: '2026-10-23T14:35:02Z', preflightLevel: 'insufficient' }),
    );
    assert.equal(report.tiers.find((t) => t.id === 'H2').status, 'pass');
    assert.equal(report.tierReached, 'H3');
});

test('G-19: a sub-second mtime/verdict rounding is not a failure', () => {
    /* The hook stamps whole seconds, the pack carries milliseconds — same second must agree. */
    const report = runHostConformance(
        fixture({ packMtime: '2026-10-23T14:29:30.900Z', preflightAt: '2026-10-23T14:29:30Z' }),
    );
    assert.equal(report.tiers.find((t) => t.id === 'H2').status, 'pass');
});

test('G-19: an unparseable `at` fails H2 instead of slipping through', () => {
    const report = runHostConformance(fixture({ packMtime: '2026-10-23T14:29:30Z', preflightAt: 'yesterday-ish' }));
    const h2 = report.tiers.find((t) => t.id === 'H2');
    assert.equal(h2.status, 'fail');
    assert.match(h2.detail, /not a parseable time/);
});

test('hooks without the pack stop at H0-H1', () => {
    const report = runHostConformance(fixture({ pack: false }));
    assert.equal(report.tiers.find((t) => t.id === 'H1').status, 'fail');
    assert.equal(report.tierReached, 'H0');
});

test('H5 skips for a consumer that never declared an editable surface', () => {
    const report = runHostConformance(fixture());
    assert.equal(report.tiers.find((t) => t.id === 'H5').status, 'skip');
    assert.equal(report.tierReached, 'H3');
    assert.equal(report.ok, true);
});

test('an editable surface that owns the hook config fails H5 and the overall verdict', () => {
    const report = runHostConformance(
        fixture({
            codex: true,
            surface: { surfaces: [{ id: 'codex', editable: ['AGENTS.md', '.codex/hooks.json'] }] },
        }),
    );
    const h5 = report.tiers.find((t) => t.id === 'H5');
    assert.equal(h5.status, 'fail');
    assert.equal(report.surface.violations[0].kind, 'gate-in-editable-surface');
    // The host is wired (H3), but a guard the optimizer can delete is not a working host.
    assert.equal(report.ok, false);
    assert.equal(report.tierReached, 'H3');
});

test('a surface that keeps the hooks outside its editable set passes H5', () => {
    const report = runHostConformance(
        fixture({
            codex: true,
            surface: { surfaces: [{ id: 'codex', editable: ['AGENTS.md', '.agents/skills/**'] }] },
        }),
    );
    assert.equal(report.tiers.find((t) => t.id === 'H5').status, 'pass');
    assert.equal(report.ok, true);
});

test('an undeclared but codex-wired tree still reaches H3', () => {
    const report = runHostConformance(fixture({ codex: true }));
    assert.equal(report.tiers.find((t) => t.id === 'H0').status, 'pass');
    assert.equal(report.tierReached, 'H3');
});
