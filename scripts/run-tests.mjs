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
 *
 * Coverage is part of the exit code, not just the log: a listed suite that disappeared used to print
 * `SKIP` and still exit 0, so deleting a suite left CI green while 42 tests stopped running. A
 * required suite that is missing, or has no tests left, now fails the run, and the `eso/` suites must
 * still contribute at least `ESO_TEST_FLOOR` tests.
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
    'packages/harness-cli/src',
    'eso/learn/test',
    'eso/core/test',
    'eso/evidence/test',
    'eso/graph/test',
    'eso/iam/test',
    'eso/knowledge/test',
    'eso/control-plane/test',
    'eso/cli',
    'qc',
];

/**
 * Suites that must be present *and* still hold tests.
 *
 * `eso-core`, `decision` and `system-one` are intentionally test-less today, so they stay unlisted
 * here; they are in `SUITES` so that adding a test file is enough to have it picked up.
 */
const REQUIRED_SUITES = new Set([...SUITES.filter((rel) => rel.startsWith('eso/')), 'qc']);

/**
 * Ratchet over the `eso/` suites: the floor the ticket states, not a snapshot of today's total (that
 * total moves whenever a peer adds a test, and a floor that tracks it would red their branch). Losing
 * one small suite is caught by `REQUIRED_SUITES` instead; the floor catches a wholesale collapse.
 *
 * 210 already excludes `eso/cli`, which was missing from `SUITES` until 2026-11-05, so its
 * `init-profile` suite — the ESO-368 acceptance tests — never ran in CI. It is listed now.
 * Raise the floor when tests are added; lower it only for tests removed on purpose, named in the commit.
 */
const ESO_TEST_FLOOR = 210;

/** `bun test` prints `Ran 42 tests across 1 file.` — read the count so a vanished suite cannot hide. */
export function parseRanCount(output) {
    const match = /Ran (\d+) tests? across/.exec(String(output || ''));
    return match ? Number(match[1]) : null;
}

/** `1 test` reads better than `1 tests` in a CI log. */
function plural(n) {
    return `${n} test${n === 1 ? '' : 's'}`;
}

/** `bun test` exit codes: 0 pass, 1 test failure, >1 runner error. Capture, then classify. */
function runSuite(rel) {
    const cwd = path.join(REPO, rel);
    if (!fs.existsSync(cwd)) {
        return { rel, status: 'missing', ran: null };
    }
    const res = spawnSync(process.env.BUN_BIN || 'bun', ['test'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
        return { rel, status: 'error', output: String(res.error.message || res.error), ran: null };
    }
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const ran = parseRanCount(output);
    /*
     * `No tests found!` is not a failure by itself. Not every package has unit tests — but a package
     * that used to have them must not quietly become one of those (`REQUIRED_SUITES` decides).
     */
    if (res.status !== 0 && /No tests found!/.test(output)) {
        return { rel, status: 'none', output, ran: null };
    }
    return { rel, status: res.status === 0 ? 'pass' : 'fail', output, ran };
}

/**
 * Decide what a suite's status means for the exit code. Pure so the rule can be exercised without
 * deleting a suite: `missing`/`none` fail for a required suite, and stay informational otherwise.
 */
export function suiteFailure(result, required = REQUIRED_SUITES.has(result.rel)) {
    if (result.status === 'fail' || result.status === 'error') return true;
    if (result.status === 'missing' || result.status === 'none') return required;
    return false;
}

/** `eso/` coverage verdict. A shortfall means tests were removed without saying so. */
export function coverageShortfall({ esoRan, floor = ESO_TEST_FLOOR }) {
    return typeof esoRan === 'number' && esoRan < floor ? { esoRan, floor } : null;
}


/**
 * Test suites need PostgreSQL (D-93). If the caller did not provide one, start a disposable
 * postgres:17-alpine container and export the same URL under every test DB name.
 * No SQLite fallback: if Docker is unavailable, fail before running suites.
 */
function ensureTestDatabase() {
    if (process.env.ESO_TEST_DB_URL || process.env.ESO_GRAPH_DB_URL || process.env.ESO_CTX_DB_URL) return;
    const info = spawnSync('docker', ['info'], { encoding: 'utf8' });
    if (info.status !== 0) {
        console.error('TEST_DB_UNAVAILABLE: set ESO_TEST_DB_URL / ESO_GRAPH_DB_URL or make Docker available');
        process.exit(2);
    }
    const name = `eso-test-pg-${process.pid}-${Date.now()}`;
    const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const run = spawnSync('docker', ['run', '--rm', '-d', '--name', name,
        '-e', 'POSTGRES_USER=eso', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=eso',
        '--health-cmd', 'pg_isready -U eso -d eso', '--health-interval', '1s', '--health-retries', '20',
        '-p', '127.0.0.1::5432', 'postgres:17-alpine'], { encoding: 'utf8' });
    if (run.status !== 0) {
        console.error('TEST_DB_START_FAILED:', run.stderr || run.stdout);
        process.exit(2);
    }
    const portOut = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' });
    const port = (portOut.stdout || '').trim().split(':').pop();
    let healthy = false;
    for (let i = 0; i < 60 && port; i++) {
        const health = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], { encoding: 'utf8' });
        if ((health.stdout || '').trim() === 'healthy') { healthy = true; break; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!healthy || !port) {
        spawnSync('docker', ['rm', '-f', name]);
        console.error('TEST_DB_NOT_READY');
        process.exit(2);
    }
    const url = `postgres://eso:${password}@127.0.0.1:${port}/eso`;
    process.env.ESO_TEST_DB_URL = url;
    process.env.ESO_GRAPH_DB_URL = url;
    process.env.ESO_CTX_DB_URL = url;
    process.on('exit', () => { spawnSync('docker', ['rm', '-f', name]); });
}

function main() {
    ensureTestDatabase();
    /*
     * Positional arguments restrict the run to named suites, for a targeted check; `bun run test`
     * passes none and stays the full gate. The coverage ratchet only applies to the full run, since a
     * subset cannot meet a total.
     */
    const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
    const unknown = requested.filter((rel) => !SUITES.includes(rel));
    if (unknown.length) {
        console.error(`unknown suite(s): ${unknown.join(', ')}`);
        console.error(`known: ${SUITES.join(', ')}`);
        process.exit(2);
    }
    const selected = requested.length ? SUITES.filter((rel) => requested.includes(rel)) : SUITES;
    const fullRun = requested.length === 0;

    /*
     * Builds that a test suite depends on, all of which produce a gitignored `dist/` — so a clean
     * checkout has none of them and the suites that need them fail for reasons that have nothing to
     * do with the change under test. Keep this list explicit rather than hiding the dependency
     * inside each test:
     *   - `eso/control-plane` — `qc/eso-cp-nestjs.test.mjs` imports `dist/server.js`.
     *   - `eso/ui` — `qc/eso-ui-conformance.test.mjs` imports `eso/ui/src/index.mjs`, whose every
     *     path points into `eso/ui/dist`.
     *   - host pack — `initProfile` / `applyHostProfiles` throw `host pack not built` without
     *     `packages/harness-host-generic/dist/host-pack`, which every provisioning suite calls.
     */
    const BUILDS = [
        { rel: 'eso/control-plane', script: 'build' },
        { rel: 'eso/ui', script: 'build' },
        { rel: '.', script: 'build:host-pack' },
    ];
    let buildFailed = false;
    for (const b of BUILDS) {
        const cwd = path.join(REPO, b.rel);
        if (!fs.existsSync(cwd)) continue;
        const res = spawnSync(process.env.BUN_BIN || 'bun', ['run', b.script], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (res.status !== 0) {
            buildFailed = true;
            const output = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-20);
            console.error(`  FAIL  build ${b.rel} (${b.script})`);
            for (const line of output) console.error(`        ${line}`);
        }
    }
    if (buildFailed) {
        console.error('build failed — suites not run');
        process.exit(1);
    }

    const results = selected.map(runSuite);
    let failed = 0;

    for (const r of results) {
        const bad = suiteFailure(r);
        if (r.status === 'pass') {
            console.log(`  ok    ${r.rel}${r.ran === null ? '' : ` (${plural(r.ran)})`}`);
            continue;
        }
        if (r.status === 'missing') {
            console.log(`  ${bad ? 'FAIL' : 'SKIP'}  ${r.rel} (not present${bad ? ' — listed as required' : ''})`);
            if (bad) failed += 1;
            continue;
        }
        if (r.status === 'none') {
            console.log(`  ${bad ? 'FAIL' : '--'}    ${r.rel} (no test files${bad ? ' — a required suite must hold tests' : ''})`);
            if (bad) failed += 1;
            continue;
        }
        failed += 1;
        console.log(`  FAIL  ${r.rel}`);
        for (const line of String(r.output || '').trim().split('\n').slice(-40)) {
            console.log(`        ${line}`);
        }
    }

    const esoResults = results.filter((r) => r.rel.startsWith('eso/'));
    const esoRan = esoResults.reduce((sum, r) => sum + (r.ran || 0), 0);
    console.log(`\n  eso coverage: ${plural(esoRan)} across ${esoResults.length} suites (floor ${ESO_TEST_FLOOR})`);

    if (fullRun) {
        const shortfall = coverageShortfall({ esoRan });
        if (shortfall) {
            failed += 1;
            console.error(
                `  FAIL  eso coverage dropped to ${plural(shortfall.esoRan)}, below the ${shortfall.floor} floor — ` +
                'restore the removed tests, or lower the floor and say which tests went in the commit',
            );
        }
    }

    console.log();
    if (failed) {
        console.error(`${failed} suite(s) failed`);
        process.exit(1);
    }
    console.log(
        `all ${results.length} suites passed (${results.filter((r) => r.status === 'pass').length} with tests, ${results.filter((r) => r.status === 'none').length} with none)`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
