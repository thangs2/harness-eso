#!/usr/bin/env node
/**
 * Validate the CI workflow before CI does.
 *
 * Why this exists: a YAML typo in `.github/workflows/ci.yml` fails as "Invalid workflow file" with no
 * line number, after a push, and the failure is *in the gate* rather than in the code — the one failure
 * a repository cannot afford, because the next instinct is to disable the gate. This script also pins
 * the parts of the file that are load-bearing rather than cosmetic:
 *
 *   - the unit suites run on all three target OSes (issue #12: the matrix *is* the fix's evidence);
 *   - every job names the OS it is supposed to cover, so "windows-latest" cannot be dropped silently;
 *   - the portability job builds the host pack before running the hook smoke, because that test skips
 *     itself when the pack is absent — a skip on Windows would look like a pass.
 *
 * Deliberately not a YAML parser: the repo has no YAML dependency, and a hand-rolled structural check
 * that only looks at indentation-critical lines is enough for the assertions above. It fails loudly on
 * tabs (YAML forbids them) and on duplicate job keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'ci.yml');

function read() {
    return fs.readFileSync(WORKFLOW, 'utf8');
}

/** Top-level `jobs:` children — the only job keys in the file (2-space indent under `jobs`). */
function jobNames(yaml) {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    assert.ok(start !== -1, 'ci.yml has no top-level `jobs:` key');
    const names = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line) && line.trim()) break; // next top-level key
        const m = /^ {4}([A-Za-z][\w-]*):\s*$/.exec(line);
        if (m) names.push(m[1]);
    }
    return names;
}

const TARGETS = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

test('the workflow parses as YAML (no tabs, no duplicate job keys, jobs block present)', () => {
    const yaml = read();
    assert.equal((yaml.match(/\t/g) || []).length, 0, 'YAML forbids tabs for indentation');
    const names = jobNames(yaml);
    assert.ok(names.length >= 3, `expected at least three jobs, found ${names.join(', ')}`);
    assert.equal(new Set(names).size, names.length, `duplicate job key in ${names.join(', ')}`);
});

test('unit suites run on all three target OSes', () => {
    const yaml = read();
    const names = jobNames(yaml);
    const unit = names.find((n) => n === 'test') || names.find((n) => /test/.test(n));
    assert.ok(unit, 'no job runs the unit suites');
    // Slice this job's block: from its key to the next top-level job key.
    const start = yaml.indexOf(`    ${unit}:`);
    const rest = yaml.slice(start + 1);
    const end = rest.search(/\n {4}[A-Za-z][\w-]*:\s*\n/);
    const block = end === -1 ? rest : rest.slice(0, end);
    for (const os of TARGETS) {
        assert.ok(block.includes(os), `job "${unit}" does not run on ${os} — the matrix is the evidence for issue #12`);
    }
    assert.match(block, /bun run test/, 'the matrix must run the multi-suite runner, not a bare `bun test`');
});

test('the portability job builds the pack before the hook smoke', () => {
    const yaml = read();
    const start = yaml.indexOf('    portability:');
    assert.ok(start !== -1, 'no portability job');
    const rest = yaml.slice(start);
    const end = rest.search(/\n {4}[A-Za-z][\w-]*:\s*\n/);
    const block = end === -1 ? rest : rest.slice(0, end);
    const build = block.indexOf('build:host-pack');
    const smoke = block.indexOf('hook-portability');
    assert.ok(build !== -1, 'the portability job must build the host pack');
    assert.ok(smoke !== -1, 'the portability job must run qc/hook-portability.test.mjs');
    assert.ok(build < smoke, 'the pack must exist before the hook smoke runs, or the smoke skips itself');
});

test('every Windows path is reachable, and the POSIX-only steps say so', () => {
    const yaml = read();
    // A `shell: bash` step on Windows relies on Git Bash being on the runner image; it is, but the
    // dependency has to be visible to the next reader rather than implied by a green run.
    const windowsBlocks = yaml.split(/\n(?= {4}[A-Za-z][\w-]*:\s*\n)/).filter((b) => b.includes('windows-latest'));
    assert.ok(windowsBlocks.length >= 3, `expected Windows in the lint, smoke and unit jobs, found ${windowsBlocks.length}`);
    assert.match(yaml, /harness\.ps1/, 'the Windows operator surface must be exercised, not just installed');
});

test('the workflow does not run anything that needs Docker or a provisioned consumer', () => {
    const yaml = read();
    for (const forbidden of ['docker compose up', './install.sh', 'console.sh up', 'deploy.sh x79']) {
        assert.ok(!yaml.includes(forbidden), `CI must not run "${forbidden}" — it needs a daemon or a real consumer`);
    }
});
