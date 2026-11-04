import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_DIR = join(REPO_ROOT, 'sdlc/06.analysis/04.quality-control');

/**
 * Scenario-matrix runner.
 *
 * Why it reads the `automated` column instead of generating its own checks: the previous harness ran
 * inline snippets and then recorded the scenarios as executed, so the registry claimed coverage that
 * no test file backed. Here a scenario is `executed` only when the file named in the row exists and
 * exits 0; a row naming a missing file stays `planned`, and a row whose file fails is `failed`.
 *
 * The report never lands inside the repository. `comments/artifacts/` is tracked, so writing there
 * would make a read-only check mutate a tracked file (PB7); the default sink is a per-run directory
 * under `os.tmpdir()`.
 */

/** Split a markdown table row into trimmed cells, or null when the line is not a table row. */
function splitRow(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
    return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

/**
 * Read `scenario_id` and `automated` out of one matrix file.
 *
 * Columns are located from the header rather than by position: the matrices are hand-written and a
 * column added in front would silently shift a positional parser onto the `Given` text.
 */
export function parseScenarioMatrix(markdownPath) {
    const lines = readFileSync(markdownPath, 'utf-8').split('\n');
    let columns = null;
    const rows = [];

    for (const line of lines) {
        const cells = splitRow(line);
        if (!cells) continue;

        if (!columns) {
            if (cells[0] === 'scenario_id' && cells.includes('automated')) {
                columns = { id: 0, automated: cells.indexOf('automated'), width: cells.length };
            }
            continue;
        }

        /*
         * A file can hold more than one table (§3 lists "scenarios worth noting" with two columns).
         * Requiring the header's shape keeps those rows out without special-casing their position.
         */
        if (cells.length !== columns.width) continue;

        const id = cells[columns.id].replace(/`/g, '').trim();
        if (!/^SCN-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(id)) continue;

        rows.push({
            scenario_id: id,
            matrix: relative(REPO_ROOT, markdownPath),
            automated: cells[columns.automated].replace(/`/g, '').trim(),
        });
    }

    return rows;
}

/** A run id that ties a report to the rows it recorded. */
export function newRunId(now = new Date()) {
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
    return `RUN-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Resolve an `automated` cell against the repo root, keeping absolute paths absolute. */
function resolveAutomated(automated) {
    return isAbsolute(automated) ? automated : join(REPO_ROOT, automated);
}

/** Run one test file with the runtime the suite itself runs on. */
function runTestFile(fullPath) {
    const isBun = Boolean(process.versions?.bun);
    const args = isBun ? ['test', fullPath] : ['--test', fullPath];
    const res = spawnSync(process.execPath, args, { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 180_000 });
    return { exit_code: res.status, timed_out: res.signal === 'SIGTERM' };
}

/** Write the report, refusing any path inside the repository. */
function writeReport(reportDir, report) {
    const resolved = resolve(reportDir);
    const rel = relative(REPO_ROOT, resolved);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        throw new Error(`refusing to write the SCN report inside the repository: ${resolved}`);
    }
    mkdirSync(resolved, { recursive: true });
    writeFileSync(join(resolved, 'scn-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
}

/**
 * Execute every scenario row of a matrix set.
 *
 * `markdownPath` may be one file or a list. Each distinct `automated` file is spawned once and its
 * verdict is shared by the rows naming it, so a row never re-runs a suite another row already ran.
 */
export function runScenariosFromMarkdown({ markdownPath, reportDir = null, runId = null, now = new Date() }) {
    const matrices = Array.isArray(markdownPath) ? markdownPath : [markdownPath];
    const resolvedRunId = runId || newRunId(now);
    const started_at = now.toISOString();

    const verdicts = new Map();
    const scenarios = [];

    for (const matrix of matrices) {
        for (const row of parseScenarioMatrix(matrix)) {
            if (!row.automated) {
                scenarios.push({ ...row, status: 'planned', reason: 'no_automated_test', executed: false });
                continue;
            }

            const fullPath = resolveAutomated(row.automated);

            if (!existsSync(fullPath)) {
                scenarios.push({ ...row, status: 'planned', reason: 'test_file_missing', executed: false });
                continue;
            }
            /*
             * Only test files are spawned. A row pointing at a script would otherwise make this runner
             * an executor for anything the matrix happens to name.
             */
            if (!/\.test\.[cm]?[jt]s$/.test(fullPath)) {
                scenarios.push({ ...row, status: 'planned', reason: 'automated_not_a_test_file', executed: false });
                continue;
            }

            if (!verdicts.has(fullPath)) verdicts.set(fullPath, runTestFile(fullPath));
            const verdict = verdicts.get(fullPath);
            const pass = verdict.exit_code === 0;

            scenarios.push({
                ...row,
                status: pass ? 'executed' : 'failed',
                executed: pass,
                exit_code: verdict.exit_code,
                ...(verdict.timed_out ? { reason: 'test_file_timed_out' } : {}),
            });
        }
    }

    const totals = {
        scenarios: scenarios.length,
        executed: scenarios.filter((s) => s.status === 'executed').length,
        failed: scenarios.filter((s) => s.status === 'failed').length,
        planned: scenarios.filter((s) => s.status === 'planned').length,
        test_files_run: verdicts.size,
    };

    const report = {
        run_id: resolvedRunId,
        started_at,
        finished_at: new Date().toISOString(),
        matrices: matrices.map((m) => relative(REPO_ROOT, m)),
        totals,
        scenarios,
    };

    if (reportDir) writeReport(reportDir, report);

    return report;
}

/** Run every scenario matrix in the QC registry directory. */
export function runScenarioRegistry({ registryDir = REGISTRY_DIR, ...rest } = {}) {
    const matrices = readdirSync(registryDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => join(registryDir, name))
        .filter((path) => parseScenarioMatrix(path).length > 0);

    return runScenariosFromMarkdown({ markdownPath: matrices, ...rest });
}

/** Byte-level snapshot of the registry, used to prove the runner wrote none of it. */
function registrySnapshot() {
    return Object.fromEntries(
        readdirSync(REGISTRY_DIR)
            .filter((name) => name.endsWith('.md'))
            .sort()
            .map((name) => [name, readFileSync(join(REGISTRY_DIR, name), 'utf-8')]),
    );
}

test('ESO-375: no scenario is marked executed unless the file it names exists and passes', () => {
    const report = runScenarioRegistry({ registryDir: REGISTRY_DIR });

    assert.ok(report.totals.scenarios >= 20, `expected the registry to hold scenarios, got ${report.totals.scenarios}`);
    assert.equal(report.totals.failed, 0, 'a scenario whose named test file fails must be reported as failed');
    assert.ok(
        report.totals.executed >= 20,
        `expected >= 20 scenarios executed by real test files, got ${report.totals.executed} (run ${report.run_id})`,
    );

    // Every executed row must point at a test file that is really on disk — that is the whole claim.
    for (const row of report.scenarios.filter((s) => s.status === 'executed')) {
        const fullPath = resolveAutomated(row.automated);
        assert.ok(existsSync(fullPath), `${row.scenario_id} claims ${row.automated}, which does not exist`);
        assert.match(row.automated, /\.test\.[cm]?[jt]s$/);
        assert.equal(row.exit_code, 0);
    }

    // A row naming a missing file is never counted: 03.cfg-sdlc.md names 24 files that are not written yet.
    const missing = report.scenarios.filter((s) => s.reason === 'test_file_missing');
    assert.ok(missing.length > 0, 'the registry contains rows with unwritten automated files; they must stay planned');
    assert.ok(missing.every((s) => s.status === 'planned' && s.executed === false));

    console.log(`SCN run ${report.run_id}: ${report.totals.executed} executed, ${report.totals.failed} failed, ${report.totals.planned} planned`);
});

test('ESO-375: the report records executed/failed counts and a run id, outside the repository', () => {
    const registryBefore = registrySnapshot();
    const trackedReport = join(REPO_ROOT, 'comments/artifacts/slp/qc/scn-report.json');
    const trackedBefore = existsSync(trackedReport) ? readFileSync(trackedReport, 'utf-8') : null;

    // Kept after the run (unique per process, never inside the repo) so the run id and the counts
    // can be read back from the machine that executed the gate.
    const reportDir = join(os.tmpdir(), `eso-scn-report-${process.pid}`);
    {
        const report = runScenarioRegistry({ reportDir });

        assert.match(report.run_id, /^RUN-\d{8}T\d{6}Z-[0-9a-f]{6}$/);

        const written = JSON.parse(readFileSync(join(reportDir, 'scn-report.json'), 'utf-8'));
        assert.equal(written.run_id, report.run_id);
        assert.ok(written.totals.executed >= 20);
        assert.equal(written.totals.failed, 0);
        assert.equal(typeof written.totals.executed, 'number');
        assert.equal(typeof written.totals.failed, 'number');

        // The report lives in the temp sandbox, never in the tracked tree.
        assert.ok(relative(REPO_ROOT, reportDir).startsWith('..'), 'the report must be written outside the repository');
        assert.deepEqual(registrySnapshot(), registryBefore, 'the runner must not mutate the sdlc registry it reads');
        if (trackedBefore !== null) {
            assert.equal(readFileSync(trackedReport, 'utf-8'), trackedBefore, 'the tracked artifacts report must not be touched');
        }

        console.log(`SCN report ${written.run_id}: ${join(reportDir, 'scn-report.json')}`);
    }
});

test('ESO-375: the runner refuses a report path inside the repository', () => {
    const guarded = join(REPO_ROOT, 'comments/artifacts/slp/qc');
    const marker = join(guarded, 'scn-report.json');
    const before = existsSync(marker) ? readFileSync(marker, 'utf-8') : null;

    assert.throws(
        () => runScenariosFromMarkdown({ markdownPath: join(REGISTRY_DIR, '03.cfg-sdlc.md'), reportDir: guarded }),
        /refusing to write the SCN report inside the repository/,
    );

    assert.equal(existsSync(marker) ? readFileSync(marker, 'utf-8') : null, before, 'a refused write must leave the tracked file alone');
});

test('ESO-375: a missing file stays planned, a passing file executes, a failing file is reported failed', () => {
    const tmpDir = join(os.tmpdir(), `eso-scn-synthetic-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
        const passing = join(tmpDir, 'passing.test.mjs');
        writeFileSync(passing, 'import test from "node:test"; import assert from "node:assert"; test("passing", () => assert.ok(true));');
        const failing = join(tmpDir, 'failing.test.mjs');
        writeFileSync(failing, 'import test from "node:test"; import assert from "node:assert"; test("failing", () => assert.equal(1, 2));');

        const mdPath = join(tmpDir, 'matrix.md');
        writeFileSync(mdPath, `
| scenario_id | ac_ref | type | Given | When | Then | automated | status |
|---|---|---|---|---|---|---|---|
| \`SCN-DUMMY-01\` | AC-1 | happy | g | w | t | \`${passing}\` | planned |
| \`SCN-DUMMY-02\` | AC-2 | happy | g | w | t | \`non-existent-test.mjs\` | planned |
| \`SCN-DUMMY-03\` | AC-3 | failure | g | w | t | \`${failing}\` | planned |
`);

        const report = runScenariosFromMarkdown({ markdownPath: mdPath });
        assert.equal(report.totals.scenarios, 3);

        const byId = Object.fromEntries(report.scenarios.map((s) => [s.scenario_id, s]));
        assert.equal(byId['SCN-DUMMY-01'].status, 'executed');
        assert.equal(byId['SCN-DUMMY-01'].executed, true);
        assert.equal(byId['SCN-DUMMY-02'].status, 'planned');
        assert.equal(byId['SCN-DUMMY-02'].executed, false);
        assert.equal(byId['SCN-DUMMY-03'].status, 'failed');
        assert.equal(byId['SCN-DUMMY-03'].executed, false);

        assert.equal(report.totals.executed, 1);
        assert.equal(report.totals.failed, 1);
        assert.equal(report.totals.planned, 1);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
