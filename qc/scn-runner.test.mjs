import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runner that reads scenario matrix markdown, runs tests only when automated files exist,
 * writes report to comments/artifacts/slp/qc/, and NEVER mutates sdlc/ files.
 */
export function runScenariosFromMarkdown({ markdownPath, reportDir = null }) {
    const content = readFileSync(markdownPath, 'utf-8');
    const lines = content.split('\n');
    const results = [];

    for (const line of lines) {
        const match = line.match(/^\|\s*`([^`]+)`\s*\|[^\|]+\|[^\|]+\|[^\|]+\|[^\|]+\|[^\|]+\|\s*`?([^\|`]+)`?\s*\|\s*([^\|]+)\|/);
        if (match) {
            const scnId = match[1].trim();
            const automatedPath = match[2].trim();

            if (scnId === 'scenario_id' || automatedPath === 'automated') continue;

            const fullPath = isAbsolute(automatedPath) ? automatedPath : join(REPO_ROOT, automatedPath);
            if (!existsSync(fullPath)) {
                results.push({
                    scenario_id: scnId,
                    automated: automatedPath,
                    status: 'planned',
                    reason: 'test_file_missing',
                    executed: false,
                });
            } else {
                const isBun = Boolean(process.versions?.bun);
                const testArgs = isBun ? ['test', fullPath] : ['--test', fullPath];
                const runRes = spawnSync(process.execPath, testArgs, { encoding: 'utf-8' });
                const pass = runRes.status === 0;
                results.push({
                    scenario_id: scnId,
                    automated: automatedPath,
                    status: pass ? 'executed' : 'failed',
                    executed: pass,
                    exit_code: runRes.status,
                });
            }
        }
    }

    if (reportDir) {
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, 'scn-report.json'), JSON.stringify(results, null, 2), 'utf-8');
    }

    return results;
}

test('ESO-375 / DoD B7: SCN runner does not mark executed when test files missing and never mutates sdlc/', () => {
    const registryPath = join(REPO_ROOT, 'sdlc/06.analysis/04.quality-control/03.cfg-sdlc.md');
    const beforeContent = readFileSync(registryPath, 'utf-8');

    const reportDir = join(REPO_ROOT, 'comments/artifacts/slp/qc');
    const results = runScenariosFromMarkdown({ markdownPath: registryPath, reportDir });

    const afterContent = readFileSync(registryPath, 'utf-8');

    // 1. Invariant: Test must never mutate tracked files in sdlc/
    assert.equal(beforeContent, afterContent, 'sdlc registry file must NOT be mutated by SCN runner');

    // 2. Invariant: 0 SCN executed when automated test files are missing
    const executed = results.filter((r) => r.executed);
    assert.equal(executed.length, 0, 'Must NOT mark any SCN as executed when test files are missing');

    // 3. Report file must be written to comments/artifacts/slp/qc/
    const reportPath = join(reportDir, 'scn-report.json');
    assert.ok(existsSync(reportPath), 'SCN report must be written to reportDir');
    const reportData = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(reportData.length, 24);
    assert.ok(reportData.every((r) => r.status === 'planned' && r.executed === false));
});

test('ESO-375 / DoD B7: SCN runner executes real test when file exists', () => {
    const tmpDir = join(os.tmpdir(), `eso-scn-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
        const testFile = join(tmpDir, 'dummy.test.mjs');
        writeFileSync(testFile, 'import test from "node:test"; import assert from "node:assert"; test("dummy", () => assert.ok(true));');

        const mdPath = join(tmpDir, 'matrix.md');
        writeFileSync(mdPath, `
| scenario_id | ac_ref | type | Given | When | Then | automated | status |
|---|---|---|---|---|---|---|---|
| \`SCN-DUMMY-01\` | AC-1 | happy | g | w | t | \`${testFile}\` | planned |
| \`SCN-DUMMY-02\` | AC-2 | happy | g | w | t | \`non-existent-test.mjs\` | planned |
`);

        const results = runScenariosFromMarkdown({ markdownPath: mdPath });
        assert.equal(results.length, 2);

        const r1 = results.find((r) => r.scenario_id === 'SCN-DUMMY-01');
        assert.equal(r1.status, 'executed');
        assert.equal(r1.executed, true);

        const r2 = results.find((r) => r.scenario_id === 'SCN-DUMMY-02');
        assert.equal(r2.status, 'planned');
        assert.equal(r2.executed, false);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
