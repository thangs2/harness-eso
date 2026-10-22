import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_PATH_POLICY,
    isSotPath,
    pathMode,
    resolvePathPolicy,
    toRepoRelative,
} from './path-policy.mjs';

/**
 * `protect` and `source of truth` are different axes, and the point of this module is that neither
 * implies the other:
 *
 * |            | source of truth | not source of truth |
 * |------------|-----------------|---------------------|
 * | gated      | `document/mu/`  | `scripts/ci/`       |
 * | writable   | `sdlc/08.wbs/`  | `tmp/`              |
 *
 * `sdlc/08.wbs/` is the WBS source of truth and agents must maintain it — so it must not be gated by
 * default. `scripts/ci/` is not a source of truth and is gated anyway, because editing the yardstick is
 * how it comes to read PASS.
 */

test('a consumer that declares nothing keeps the historical protection', () => {
    /*
     * The load-bearing case for shipping this at all. If absent configuration resolved to "protect
     * nothing", then deploying the feature would have silently removed every gate — a removal nobody
     * asked for and nothing would have reported.
     */
    const resolved = resolvePathPolicy(undefined);
    assert.equal(resolved.declared, false);
    assert.deepEqual(resolved.gated, DEFAULT_PATH_POLICY.gated);
    assert.equal(pathMode('document/mu/be/03.scaffolding/x.md', resolved), 'gated');
    assert.equal(pathMode('scripts/ci/verify.sh', resolved), 'gated');
});

test('an explicitly empty list means protect nothing, and is not a fallback', () => {
    // The escape hatch has to be distinguishable from "not configured", or a consumer can never
    // deliberately turn a tier off.
    const resolved = resolvePathPolicy({ paths: { gated: [], ask: [], locked: [], sot: [] } });
    assert.equal(resolved.declared, true);
    assert.deepEqual(resolved.gated, []);
    assert.equal(pathMode('document/mu/be/x.md', resolved), null);
});

test('a declared list replaces the default rather than merging into it', () => {
    /*
     * Merging would resurrect defaults the consumer removed. That is the `sdlc/` case exactly: it sat
     * in the default gated list while the repo's own `locked-paths.txt` said "sdlc/ is the writable
     * working tree. Do not lock it."
     */
    const resolved = resolvePathPolicy({ paths: { gated: ['document/mu/'] } });
    assert.deepEqual(resolved.gated, ['document/mu/']);
    assert.equal(pathMode('scripts/ci/x', resolved), null, 'a removed default must stay removed');
    assert.equal(pathMode('document/mu/x', resolved), 'gated');
});

test('sdlc is writable by default but its sources of truth are not', () => {
    // The decision this module exists to make expressible: same directory, two answers, by sub-path.
    const resolved = resolvePathPolicy({
        paths: { gated: ['document/mu/'], ask: ['sdlc/08.wbs/', 'sdlc/00.governance/'], sot: ['sdlc/08.wbs/'] },
    });
    assert.equal(pathMode('sdlc/03.analysis/04.quality-control/01.md', resolved), null, 'working tree');
    assert.equal(pathMode('sdlc/08.wbs/03.stories/x/02.qc.md', resolved), 'ask');
    assert.equal(pathMode('sdlc/00.governance/05.operating-model/00.index.md', resolved), 'ask');
    // And it is *also* a source of truth — the two answers coexist.
    assert.equal(isSotPath('sdlc/08.wbs/03.stories/x/02.qc.md', resolved), true);
});

test('the most restrictive tier wins when a path is listed twice', () => {
    // A path accidentally present in two tiers must not be loosened by whichever is checked last.
    const resolved = resolvePathPolicy({
        paths: { locked: ['document/mu/'], gated: ['document/mu/'], ask: ['document/mu/'] },
    });
    assert.equal(pathMode('document/mu/x.md', resolved), 'locked');
});

test('MCP config files are locked by default, not merely gated (H7)', () => {
    /*
     * `mcp.json` carries the credentials the MCP servers run with, and the root `.mcp.json` is a copy
     * of one of them. `gated` would open them to any turn that collected enough evidence — reading
     * enough files is not a decision about a secret — so the default has to be `locked`.
     */
    const resolved = resolvePathPolicy({});
    for (const rel of ['.cursor/mcp.json', '.vscode/mcp.json', '.agents/mcp_config.json', '.mcp.json']) {
        assert.equal(pathMode(rel, resolved), 'locked', `${rel} must be locked`);
    }
});

test('entries match a directory subtree, and exact files only when written exactly', () => {
    const resolved = resolvePathPolicy({
        paths: { gated: ['frontend/', 'AGENTS.md', '.cursor/rules/'] },
    });
    assert.equal(pathMode('frontend/src/app.ts', resolved), 'gated', 'directory entry covers subtree');
    /*
     * The bare directory name is covered too. It reads oddly for a *write* target — a file literally named
     * `frontend` — but the Python guard and the consent store both include it, and the three have to agree:
     * if one of them covered a target the others did not, a person's approval would open one channel and not
     * the next.
     */
    assert.equal(pathMode('frontend', resolved), 'gated', 'including the bare directory name');
    assert.equal(pathMode('AGENTS.md', resolved), 'gated', 'exact entry matches the file');
    assert.equal(pathMode('AGENTS.md.bak', resolved), null, 'but not its siblings');
    assert.equal(pathMode('docs/AGENTS.md', resolved), null, 'nor a same-named file elsewhere');
    assert.equal(pathMode('.cursor/rules/core.mdc', resolved), 'gated');
});

test('a prefix entry matches any name it prefixes, which a directory entry cannot express', () => {
    /*
     * The regression this rule exists for. `backend/mu-` was a **prefix** in the original code, matched with
     * `startswith`, and gating `backend/mu-fusion/`, `backend/mu-infra-lib/` and every other `mu-*` service.
     * Collapsing the two original lists into one policy list lost the distinction: as a non-directory entry
     * `backend/mu-` matched no path at all, so all backend code became writable without a gate — the most
     * consequential directory in the repo, silently open.
     *
     * A `*` suffix states the intent. Without it, the entry is exact and only the literal path `backend/mu-`
     * would match.
     */
    const resolved = resolvePathPolicy({ paths: { gated: ['backend/mu-*'] } });
    assert.equal(pathMode('backend/mu-fusion/src/a.ts', resolved), 'gated');
    assert.equal(pathMode('backend/mu-infra-lib/x.ts', resolved), 'gated');
    assert.equal(pathMode('backend/mu-recruitment/y.ts', resolved), 'gated');
    assert.equal(pathMode('backend/other/a.ts', resolved), null, 'and nothing else');
    assert.equal(pathMode('backend/mu-fusion', resolved), 'gated', 'the bare prefix target too');

    // Without the `*` it is an exact entry, which is how `AGENTS.md` stays precise.
    const exact = resolvePathPolicy({ paths: { gated: ['backend/mu-'] } });
    assert.equal(pathMode('backend/mu-fusion/src/a.ts', exact), null);
    assert.equal(pathMode('backend/mu-', exact), 'gated');
});

test('targets are normalised, so policy entries stay short', () => {
    assert.equal(toRepoRelative('./sdlc/a.md', '/repo'), 'sdlc/a.md');
    assert.equal(toRepoRelative('/repo/sdlc/a.md', '/repo'), 'sdlc/a.md');
    assert.equal(toRepoRelative('sdlc/a.md', '/repo/'), 'sdlc/a.md');
    assert.equal(toRepoRelative('', '/repo'), '');

    // A guard receives absolute paths from the shell; the policy is written repo-relative.
    const resolved = resolvePathPolicy({ paths: { gated: ['document/mu/'] } });
    assert.equal(pathMode('/repo/document/mu/be/x.md', resolved, '/repo'), 'gated');
});

test('the source-of-truth registry never denies anything', () => {
    // It is a label. Any enforcement derived from it would recreate the bug this module fixes.
    const resolved = resolvePathPolicy({ paths: { sot: ['document/mu/'], gated: [] } });
    assert.equal(isSotPath('document/mu/be/x.md', resolved), true);
    assert.equal(pathMode('document/mu/be/x.md', resolved), null, 'sot alone does not gate');
});
