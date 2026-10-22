/**
 * Onboarding + diagnostics on a provisioned consumer.
 *
 * The two files this covers are the only part of the install an operator reads *after* the install, so
 * the interesting failures are not "is the file there" — they are "does the script still describe the
 * consumer it runs in" and "does the checklist still name a command that exists".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ensureConsumerOnboarding } from '../packages/harness-foundation/src/host-install.mjs';
import { syncConsumerDocs } from '../packages/harness-cli/src/fix-consumer-cmd.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ESO_ROOT, 'profiles', 'templates');

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eso-onboarding-'));
}

function runScript(root, args = [], env = {}) {
    return spawnSync('bash', [path.join(root, '.harness', 'diagnostics.sh'), ...args], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, HARNESS_ESO_ROOT: ESO_ROOT, ...env },
    });
}

test('provision seeds the checklist and an executable diagnostic', () => {
    const root = tempRoot();
    const actions = ensureConsumerOnboarding(root);

    const created = actions.map((a) => a.relative).sort();
    assert.deepEqual(created, ['.harness/ONBOARDING.md', '.harness/diagnostics.sh']);
    assert.ok(fs.existsSync(path.join(root, '.harness/ONBOARDING.md')));

    const mode = fs.statSync(path.join(root, '.harness/diagnostics.sh')).mode & 0o111;
    assert.ok(mode !== 0, 'diagnostics.sh must be executable — a chmod the operator forgets is "permission denied"');
});

test('a consumer that already has these files keeps its own copy', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/ONBOARDING.md'), '# edited by the operator\n');

    const actions = ensureConsumerOnboarding(root);
    assert.deepEqual(actions.map((a) => a.relative), ['.harness/diagnostics.sh']);
    assert.match(fs.readFileSync(path.join(root, '.harness/ONBOARDING.md'), 'utf8'), /edited by the operator/);
});

test('fix docs refreshes all three operator documents, not only the guide', () => {
    const root = tempRoot();
    // Deliberately stale copies: `fix consumer` derives its work from failing checks, so a consumer
    // whose T1.1 passes would otherwise never pick these up.
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    for (const f of ['WORKFLOW_GUIDE.md', 'ONBOARDING.md', 'diagnostics.sh']) {
        fs.writeFileSync(path.join(root, '.harness', f), 'stale\n');
    }

    const result = syncConsumerDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.synced.sort(), [
        '.harness/ONBOARDING.md',
        '.harness/WORKFLOW_GUIDE.md',
        '.harness/diagnostics.sh',
    ]);
    for (const f of ['WORKFLOW_GUIDE.md', 'ONBOARDING.md', 'diagnostics.sh']) {
        const body = fs.readFileSync(path.join(root, '.harness', f), 'utf8');
        assert.notEqual(body, 'stale\n', `${f} was not refreshed`);
        assert.equal(body, fs.readFileSync(path.join(TEMPLATES, f), 'utf8'), `${f} must match the template`);
    }
});

test('fix docs --dry-run writes nothing', () => {
    const root = tempRoot();
    const result = syncConsumerDocs(root, { dryRun: true });
    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(path.join(root, '.harness/diagnostics.sh')));
});

test('the diagnostic is read-only: a run does not change the consumer tree', () => {
    const root = tempRoot();
    ensureConsumerOnboarding(root);
    const snapshot = () =>
        fs
            .readdirSync(path.join(root, '.harness'), { withFileTypes: true })
            .map((d) => d.name)
            .sort();
    const before = snapshot();
    runScript(root, ['L0']);
    assert.deepEqual(snapshot(), before, 'a diagnostic that writes cannot be trusted to report');
});

test('a blocker failure exits 1, and --json reports the same verdict', () => {
    const root = tempRoot();
    ensureConsumerOnboarding(root);

    const plain = runScript(root, ['L0']);
    assert.equal(plain.status, 1, 'missing harness.config.json is a blocker');

    const json = runScript(root, ['L0', '--json']);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.summary.blockerFail > 0);
    assert.ok(Array.isArray(report.layers.L0));
    assert.ok(report.layers.L0.some((r) => r.id === 'L0:presence:harness.config.json'));
});

test('a single layer reports only that layer', () => {
    const root = tempRoot();
    ensureConsumerOnboarding(root);
    const report = JSON.parse(runScript(root, ['L3', '--json']).stdout);
    assert.deepEqual(Object.keys(report.layers), ['L3']);
});

test('every layer the checklist documents is one the script can run', () => {
    const onboarding = fs.readFileSync(path.join(TEMPLATES, 'ONBOARDING.md'), 'utf8');
    const documented = [...onboarding.matchAll(/^## (L\d) — /gm)].map((m) => m[1]);
    assert.deepEqual(documented, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);

    const root = tempRoot();
    ensureConsumerOnboarding(root);
    for (const layer of documented) {
        const report = JSON.parse(runScript(root, [layer, '--json']).stdout);
        assert.ok(report.layers[layer]?.length > 0, `${layer} produced no rows`);
    }
});

test('the checklist only names harnessctl commands the CLI implements', () => {
    /*
     * A checklist that tells the operator to run a command that was renamed is worse than no
     * checklist: they follow it, get `unknown command`, and stop reading. Only the `harnessctl`
     * invocations are checked — consumer-local commands (`docgraph build`) belong to other tools.
     */
    const cli = fs.readFileSync(path.join(ESO_ROOT, 'packages/harness-cli/src/cli.mjs'), 'utf8');
    const onboarding = fs.readFileSync(path.join(TEMPLATES, 'ONBOARDING.md'), 'utf8');
    // Only commands the operator is told to *run*: a line in a fenced block or an inline snippet
    // that starts with the tool. Prose that happens to contain the word ("harnessctl unavailable")
    // is not an instruction, and matching it would make this test fail on its own documentation.
    const codeish = [
        ...[...onboarding.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]),
        ...[...onboarding.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    ].filter((s) => /(^|\s)harnessctl\s/.test(s) && !/^harnessctl\s+(unavailable|version)\b/.test(s.trim()));
    const commands = new Set();
    for (const block of codeish) {
        for (const m of block.matchAll(/harnessctl ([a-z-]+)(?: ([a-z-]+))?/g)) {
            commands.add(m[2] && !m[2].startsWith('-') && !m[2].includes('<') ? `${m[1]} ${m[2]}` : m[1]);
        }
    }
    assert.ok(commands.size > 0, 'the checklist must name at least one harnessctl command');
    for (const cmd of commands) {
        if (cmd.includes('<')) continue;
        const [first, second] = cmd.split(' ');
        /*
         * Three dispatch shapes exist, and a check that knows only one reports false failures on the
         * others — which is how a guard like this gets deleted instead of fixed:
         *   1. inline:      `cmd === 'fix' && argv[1] === 'consumer'`
         *   2. guarded:     `cmd === 'capability'` then `if (argv[1] !== 'probe') …` — an allow-list,
         *                   so the verb appears as a rejection rather than a dispatch
         *   3. single verb: `cmd === 'token-diet'`
         *   4. runner:      `cmd === 'host-pack'` + `runHostPack(sub, …)` with its own `case` table
         */
        const inline = !second && new RegExp(`cmd === '${first}'`).test(cli);
        const routedInline = second && new RegExp(`cmd === '${first}' && argv\\[1\\] === '${second}'`).test(cli);
        const guarded =
            second &&
            new RegExp(`cmd === '${first}'[\\s\\S]{0,300}?argv\\[1\\] !== '${second}'`).test(cli);
        let routedRunner = false;
        if (second) {
            // `runHostPack(sub, …)` / `runObservatory(sub, rest, …)` — scan past the usage line.
            const runner = cli.match(
                new RegExp(`cmd === '${first}'[\\s\\S]{0,900}?run([A-Za-z]+)\\(sub[,)]`),
            );
            if (runner) {
                const kebab = runner[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
                const dir = path.join(ESO_ROOT, 'packages/harness-cli/src');
                const candidates = [`${kebab}.mjs`, `${kebab}-cmd.mjs`, 'host-pack-cmd.mjs']
                    .map((f) => path.join(dir, f))
                    .filter((f) => fs.existsSync(f));
                // A runner may dispatch with `case 'up':` or by comparing `subcommand === 'up'`.
                routedRunner = candidates.some((f) => {
                    const body = fs.readFileSync(f, 'utf8');
                    return (
                        new RegExp(`case '${second}':`).test(body) ||
                        new RegExp(`subcommand === '${second}'`).test(body)
                    );
                });
            }
        }
        assert.ok(
            inline || routedInline || guarded || routedRunner,
            `checklist names "harnessctl ${cmd}" but the CLI does not dispatch it`,
        );
    }
});
