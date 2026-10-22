#!/usr/bin/env node
/**
 * Run every Bun-native test suite, one directory at a time.
 *
 * Why this exists: `bunfig.toml` pins `[test] root = "./qc"` so that a bare `bun test` is the quick
 * unit run. That setting also **overrides the paths you pass on the command line** — the root script
 * listed five directories and quietly ran only `qc`, so the `observe-server`, `foundation`,
 * `eso-core`, `decision` and `system-one` suites (14 files) had never executed. `bun test --root` is
 * not a supported flag, so the only way to reach a directory outside the pinned root is to run from
 * inside it.
 *
 * This is a Node script rather than a shell one-liner because the repo runs on Windows too
 * (`deploy.sh` is bash, so Windows goes through `bun run test` instead), where `for … do … done` is not
 * a thing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every directory holding Bun-native tests. The Observatory uses Vitest and has its own script. */
const SUITES = [
    'packages/harness-foundation/src',
    'packages/harness-eso-core/src',
    'packages/harness-decision/src',
    'packages/harness-system-one/src',
    'packages/harness-host-generic/src',
    'packages/harness-observe-server/src',
    'qc',
];

/** `bun test` exit codes: 0 pass, 1 test failure, >1 runner error. Capture, then classify. */
function runSuite(rel) {
    const cwd = path.join(REPO, rel);
    if (!fs.existsSync(cwd)) {
        return { rel, status: 'missing' };
    }
    const res = spawnSync(process.env.BUN_BIN || 'bun', ['test'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
        return { rel, status: 'error', output: String(res.error.message || res.error) };
    }
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    /*
     * `No tests found!` is not a failure. Not every package has unit tests — of the directories this
     * runs, `eso-core`, `decision` and `system-one` have none. They stay listed so that adding a test
     * file is enough to have it picked up, and so the gap is visible rather than implied.
     */
    if (res.status !== 0 && /No tests found!/.test(output)) {
        return { rel, status: 'none', output };
    }
    return { rel, status: res.status === 0 ? 'pass' : 'fail', output };
}

const results = SUITES.map(runSuite);
let failed = 0;

for (const r of results) {
    if (r.status === 'pass') {
        console.log(`  ok    ${r.rel}`);
        continue;
    }
    if (r.status === 'missing') {
        console.log(`  SKIP  ${r.rel} (not present)`);
        continue;
    }
    if (r.status === 'none') {
        console.log(`  --    ${r.rel} (no test files)`);
        continue;
    }
    failed += 1;
    console.log(`  FAIL  ${r.rel}`);
    for (const line of String(r.output || '').trim().split('\n').slice(-40)) {
        console.log(`        ${line}`);
    }
}

console.log();
if (failed) {
    console.error(`${failed} suite(s) failed`);
    process.exit(1);
}
console.log(`all ${results.length} suites passed`);
