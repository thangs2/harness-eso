import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The shell entrypoints are the only surface an operator or an agent drives a consumer with:
 *
 *   deploy.sh <consumer>   provision.sh <consumer>   verify-consumer.sh <consumer>   console.sh <cmd>
 *
 * Each is a thin transport over `harness-cli`. When a flag, a registry field or an API route moves,
 * the script is the one thing that breaks — and nothing in `packages/*.test.mjs` can see it, because
 * those tests import the module the script forgot to update. `provision.sh` still read `p.port` after
 * the registry moved the port to `p.observe.port`; the module tests passed, the script was wrong.
 *
 * So these tests run the real scripts in a real child process and assert on their output and exit
 * code. Rules:
 *
 *   - `HARNESS_PRODUCT_STATE_DIR` is redirected to a temp dir for every case. No test touches
 *     `~/.harness`.
 *   - A case that would need the operator's real state or a running container is skipped with the
 *     exact command printed, never silently assumed green.
 *   - `--plan` / read-only modes are preferred: they exercise arg parsing, registry reads and the
 *     verify plumbing without writing to a consumer.
 */

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runScript(script, args, opts = {}) {
    const res = spawnSync(path.join(ESO_ROOT, script), args, {
        cwd: ESO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            ...process.env,
            ...(opts.env || {}),
        },
        input: opts.input,
    });
    // Strip ANSI so assertions read the message a human reads.
    const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
    return {
        status: res.status,
        /*
         * `status` is `null` whenever the child died from a signal, and the failure then reads as
         * "wrong exit code" when the truth is "the process was killed". Bun kills a child that
         * outlives the suite's runner window on its own, so the test that writes a diagnosis in 5s
         * and the one that is killed both look identical without this. (Measured: the same
         * `console.sh verify` case is 1 pass / 0 fail under `node --test` and 1 fail / 3 runs under
         * `bun test`, with `status: null` every time.)
         */
        signal: res.signal ?? null,
        stdout: strip(res.stdout),
        stderr: strip(res.stderr),
        error: res.error,
    };
}

function withTempState(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scripts-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('every documented entrypoint is executable and has a shebang', () => {
    for (const script of ['deploy.sh', 'provision.sh', 'verify-consumer.sh', 'console.sh']) {
        const file = path.join(ESO_ROOT, script);
        assert.ok(fs.existsSync(file), `${script} is missing`);
        const { mode } = fs.statSync(file);
        assert.ok(mode & 0o111, `${script} is not executable — docs tell the operator to run ./${script}`);
        assert.match(fs.readFileSync(file, 'utf8').split('\n')[0], /^#!.*\b(bash|sh)\b/, `${script} has no shell shebang`);
    }
});

test('every entrypoint answers --help without touching a consumer', (t) => {
    /*
     * Starting the registry empty is allowed to create an empty `workspace.json` — that is how the
     * state directory initialises itself. What `--help` must never do is write into a *consumer*, so
     * the assertion is on the consumer tree, not on the state directory's own bootstrap file.
     */
    const state = withTempState(t);
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-help-'));
    t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: consumer, rootHost: consumer, observe: { port: 9414 } }],
        }),
    );
    for (const script of ['deploy.sh', 'provision.sh', 'verify-consumer.sh', 'console.sh']) {
        const r = runScript(script, ['--help'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
        assert.equal(r.status, 0, `${script} --help exited ${r.status}: ${r.stderr || r.stdout}`);
        assert.ok((r.stdout + r.stderr).trim().length > 0, `${script} --help printed nothing`);
    }
    assert.deepEqual(fs.readdirSync(consumer), [], '--help must not write into a consumer');
});

test('an unknown consumer is refused with the list of real ones, not a stack trace', (t) => {
    const state = withTempState(t);
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: '/w/alpha', rootHost: '/w/alpha', observe: { port: 8792 } }],
        }),
    );
    const r = runScript('provision.sh', ['no-such-consumer', '--plan'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    assert.equal(r.status, 2, 'an unknown consumer is a usage error, distinct from a failed provision');
    const out = r.stdout + r.stderr;
    assert.match(out, /no-such-consumer/, 'the message names the consumer that was not found');
    assert.match(out, /alpha/, 'the message lists the consumers that do exist');
    assert.doesNotMatch(out, /at Object\.|node:internal/, 'a missing consumer is not a crash');
});

test('provision.sh writes nothing in --plan mode', (t) => {
    /*
     * `--plan` is the first thing an operator runs against a consumer they do not wants touched, and
     * the reason to trust it is that it never writes. A plan that touches `.harness/` would make the
     * next `git status` on the consumer a lie.
     */
    const state = withTempState(t);
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-'));
    t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: consumer, rootHost: consumer, observe: { port: 9413 } }],
        }),
    );
    const before = fs.readdirSync(consumer).sort();
    runScript('provision.sh', ['alpha', '--plan'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    assert.deepEqual(fs.readdirSync(consumer).sort(), before, '--plan created files in the consumer');
});

test('provision.sh resolves the port from the registry, not from a top-level field', (t) => {
    const state = withTempState(t);
    /*
     * Registry v2 shape: the port is `observe.port`. v1 also had a flat `port` row, and a script that
     * reads only the flat one still "worked" on v1 and reported an empty port on v2. This case pins
     * the v2 shape specifically.
     */
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [
                {
                    id: 'alpha',
                    displayName: 'alpha',
                    root: '/w/alpha',
                    rootHost: '/w/alpha',
                    observe: { port: 9411 },
                    status: 'draft',
                },
            ],
        }),
    );
    const r = runScript('provision.sh', ['alpha', '--plan'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    const out = r.stdout + r.stderr;
    assert.match(out, /9411/, `the script must report the registered port; got:\n${out.slice(0, 600)}`);
    assert.doesNotMatch(out, /chưa có observe port|no observe port/i, 'a registered port is not "missing"');
});

test('console.sh verify explains an undeployed Console instead of timing out', { timeout: 120_000 }, () => {
    /*
     * The timeout is not decoration. This case spawns the real script, which probes a port and waits
     * `CONSOLE_WAIT_SECONDS` before answering — 5–9s on a loaded machine, and node:test's 5000ms default
     * kills it mid-wait. The failure then reads as "wrong exit code" (status `null` from a killed child),
     * which is the shape that kept this test looking flaky while it was simply under-budget.
     */
    // No container is expected on a random port; the contract is "fail fast with a diagnosis".
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const r = runScript('console.sh', ['verify'], {
        env: { HARNESS_CONSOLE_PORT: port, CONSOLE_WAIT_SECONDS: '2' },
    });
    assert.equal(
        r.signal,
        null,
        `console.sh was killed by ${r.signal} instead of answering — a runner limit, not a verdict`,
    );
    assert.equal(r.status, 1, 'an absent Console is a failure, not a warning');
    const out = r.stdout + r.stderr;
    assert.match(out, /nothing is serving on :\d+/, 'the first line must say what is wrong');
    assert.match(
        out,
        /daemon is not running|nothing is deployed|does not exist|held by/,
        'the diagnosis must name one of the four causes, each of which has a different next command',
    );
    assert.doesNotMatch(out, /SyntaxError|ReferenceError/, 'a diagnosis is not a crash');
});

test('no entrypoint hardcodes an absolute bash path (P2 — Windows has none)', () => {
    /*
     * What broke: `sh deploy.sh x79` re-exec'd with `exec /bin/bash "$0"`, to land in bash from a
     * POSIX `sh`. On Git Bash for Windows there is no `/bin/bash` — so the portability fix for "sh is
     * dash" made the same scripts unrunnable on a third of the target platforms, and every test was
     * green because the suite only ran on macOS.
     *
     * The re-exec has to *find* a bash instead: `bash` on PATH first (that is what Git Bash installs),
     * then the two conventional absolute paths. This test is the lint described in issue #12, run in
     * the normal suite so it cannot regress the next time someone writes a portable-looking line.
     */
    const offenders = [];
    for (const script of ['deploy.sh', 'provision.sh', 'verify-consumer.sh', 'console.sh', 'install.sh', 'fix-consumer.sh']) {
        const file = path.join(ESO_ROOT, script);
        if (!fs.existsSync(file)) continue;
        let inReexecBlock = false;
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                // `#!/bin/bash` as a line 1 is fine: it is only reached on systems that have it.
                if (i === 0) return;
                if (/^\s*#/.test(line)) return;
                // What breaks Windows: naming an absolute interpreter to *run* it —
                // `exec /bin/bash "$0"`, `/bin/bash "$0"`, `$( /bin/bash … )`. Ruling out the whole
                // re-exec block would be too broad: the fallback *inside* it is the fix, and the
                // first version of this test flagged exactly that.
                if (/(?:^|[;&|(]\s*|\bexec\s+|\$\()\s*\/(?:bin|usr\/local\/bin|opt\/homebrew\/bin)\/(?:ba)?sh\b/.test(line)) {
                    offenders.push(`${script}:${i + 1}: ${line.trim()}`);
                }
            });
    }
    assert.deepEqual(offenders, [], `absolute interpreter paths break Windows:\n${offenders.join('\n')}`);
});

test('an entrypoint started under sh re-execs bash from PATH, not /bin/bash', () => {
    /*
     * Behavioural half of the same defect: invoke the script with `sh` explicitly. On this host both
     * routes work, so the assertion is that the run still succeeds *and* that the failure mode is a
     * sentence rather than `exec: /bin/bash: not found` when no absolute path is reachable.
     */
    const res = spawnSync('sh', [path.join(ESO_ROOT, 'deploy.sh'), '--help'], {
        cwd: ESO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
    });
    if (res.error && res.error.code === 'ENOENT') return; // no `sh` on this host (Windows runner)
    assert.equal(res.status, 0, `sh deploy.sh --help exited ${res.status}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr || '', /\/bin\/bash: (No such file|not found)/, 'the re-exec must not assume /bin/bash');
});

test('verify-consumer.sh reports a tier and a diagnostics path for every listed consumer', (t) => {
    const state = withTempState(t);
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-consumer-'));
    t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: consumer, rootHost: consumer, observe: { port: 9412 } }],
        }),
    );
    const r = runScript('verify-consumer.sh', ['alpha'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    const out = r.stdout + r.stderr;
    // An empty consumer reaches no tier, and that is a legitimate answer — `NONE`, not an omission.
    assert.match(out, /tierReached\s+(NONE|T\d)/, `verify must report the tier it reached; got:\n${out.slice(0, 500)}`);
    assert.match(out, /diagnostics\s+\S+latest\.md/, 'verify must name the diagnostics report');
    assert.equal(r.status, 1, 'CRITICAL failures on an empty consumer are a non-zero exit');
});

test('verify-consumer.sh --json writes a parseable document and nothing else to stdout', (t) => {
    /*
     * `--json` exists so a CI step or another script can consume the report. A banner or a closing
     * summary on stdout makes `| jq` fail, which is how a report that is 100% correct still breaks
     * the consumer of it. Prose belongs on stderr in this mode.
     */
    const state = withTempState(t);
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-json-'));
    t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: consumer, rootHost: consumer, observe: { port: 9415 } }],
        }),
    );
    const r = runScript('verify-consumer.sh', ['alpha', '--json'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout was not one JSON document:\n${r.stdout.slice(0, 300)}`);
});

test('deploy.sh --plan resolves the consumer without building anything', () => {
    /*
     * `--plan` used to build the SPA and the image before printing its plan, which made a "dry run"
     * the slowest command in the set. A dry run must be cheap enough to run before every real deploy.
     */
    const started = Date.now();
    const r = runScript('deploy.sh', ['x79', '--plan'], { env: { HARNESS_PRODUCT_STATE_DIR: '', PATH: process.env.PATH } });
    const out = r.stdout + r.stderr;
    if (/Unknown consumer/.test(out)) {
        // A machine without a provisioned x79 still exercises the refusal path; the plan assertions
        // below only apply when it exists.
        assert.equal(r.status, 2);
        return;
    }
    assert.equal(r.status, 0, `deploy.sh --plan exited ${r.status}:\n${out.slice(0, 600)}`);
    assert.match(out, /DRY RUN/, 'the plan is labelled');
    assert.doesNotMatch(out, /Building the Observatory SPA|Building the image/, 'a plan must not build');
    assert.ok(Date.now() - started < 10_000, 'a plan must finish in seconds');
});

test('verify-consumer.sh turns a failing report into exit 1 and says where the detail is', (t) => {
    /*
     * The pass path is easy to get right; the failing path is the one an operator meets. Pinned with a
     * throwaway standard (one check, wired to a file that does not exist) via HARNESS_STANDARD_PATH,
     * so the test never has to break a real consumer to see a failure.
     */
    const state = withTempState(t);
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fail-'));
    const standards = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-std-'));
    t.after(() => {
        fs.rmSync(consumer, { recursive: true, force: true });
        fs.rmSync(standards, { recursive: true, force: true });
    });
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({
            version: 2,
            defaultProjectId: 'alpha',
            projects: [{ id: 'alpha', displayName: 'alpha', root: consumer, rootHost: consumer, observe: { port: 9416 } }],
        }),
    );
    const standardPath = path.join(standards, 'std.json');
    fs.writeFileSync(
        standardPath,
        JSON.stringify({
            version: '9.9.9-test',
            id: 'consumer-maturity',
            title: 'throwaway standard',
            law: { mechanismOnly: true, forbidden: [] },
            tiers: [
                {
                    id: 'T0',
                    checks: [
                        {
                            id: 'T0.1',
                            title: 'a file that never exists',
                            severity: 'CRITICAL',
                            probe: { type: 'file_exists', path: 'this/file/does/not/exist.json' },
                            remediation: { action: 'docs', hint: 'create it — or, in this test, ignore it' },
                        },
                    ],
                },
            ],
        }),
    );
    const r = runScript('verify-consumer.sh', ['alpha'], {
        env: { HARNESS_PRODUCT_STATE_DIR: state, HARNESS_STANDARD_PATH: standardPath },
    });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, `a CRITICAL failure must exit 1, got ${r.status}:\n${out.slice(0, 600)}`);
    assert.match(out, /T0\.1/, 'the report names the failing check');
    assert.match(out, /create it/, 'the remediation is printed next to the failure');
    assert.match(out, /diagnostics\/latest\.md/, 'the full report path is printed');
});

test('deploy.sh refuses a consumer with no registry entry without starting a stack', (t) => {
    const state = withTempState(t);
    fs.writeFileSync(
        path.join(state, 'workspace.json'),
        JSON.stringify({ version: 2, defaultProjectId: null, projects: [] }),
    );
    const r = runScript('deploy.sh', ['ghost'], { env: { HARNESS_PRODUCT_STATE_DIR: state } });
    assert.notEqual(r.status, 0, 'deploying an unregistered consumer must fail');
    const out = r.stdout + r.stderr;
    assert.match(out, /ghost/, 'the message names the consumer');
    assert.doesNotMatch(out, /compose up|Creating|Creating container/i, 'nothing may be started for an unknown project');
}, 30_000);
