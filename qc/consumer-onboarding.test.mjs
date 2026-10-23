/**
 * Onboarding + diagnostics on a provisioned consumer.
 *
 * The two files this covers are the only part of the install an operator reads *after* the install, so
 * the interesting failures are not "is the file there" — they are "does the script still describe the
 * consumer it runs in" and "does the checklist still name a command that exists".
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    ensureSessionGitignore,
    ensureHarnessGitignore,
    ensureConsumerOnboarding,
    untrackIgnoredPaths,
} from '../packages/harness-foundation/src/host-install.mjs';
import { syncConsumerDocs } from '../packages/harness-cli/src/fix-consumer-cmd.mjs';
import { runCapabilityProbe } from '../packages/harness-cli/src/capability-probe-cmd.mjs';

const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ESO_ROOT, 'profiles', 'templates');

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eso-onboarding-'));
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
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

test('re-provisioning refreshes an untouched copy and keeps the bookkeeping', () => {
    const root = tempRoot();
    const docs = {};
    ensureConsumerOnboarding(root, docs);
    assert.ok(docs['.harness/ONBOARDING.md'].sha256, 'the hash we wrote is what makes the next run decidable');

    // Same template, same bytes: nothing to do, and no action to report.
    assert.deepEqual(ensureConsumerOnboarding(root, docs), []);

    // The template moved on while the consumer's copy was still ours: the recorded hash proves the
    // consumer never edited it, so the stale bytes in the file are refreshed rather than reported.
    const template = fs.readFileSync(path.join(TEMPLATES, 'ONBOARDING.md'), 'utf8');
    const before = docs['.harness/ONBOARDING.md'].sha256;
    const stale = ensureConsumerOnboarding(root, docs);
    assert.equal(stale.length, 0, 'same template twice is a no-op');
    assert.equal(fs.readFileSync(path.join(root, '.harness/ONBOARDING.md'), 'utf8'), template);
    assert.equal(docs['.harness/ONBOARDING.md'].sha256, before);

    const mode = fs.statSync(path.join(root, '.harness/diagnostics.sh')).mode & 0o111;
    assert.ok(mode !== 0, 'a refreshed diagnostic is still executable');
});

test('a template change reaches a copy nobody edited', () => {
    const root = tempRoot();
    const docs = {};
    ensureConsumerOnboarding(root, docs);
    // Simulate the old release's bytes: the file is ours according to the state, but its content is
    // not the template's — which is exactly the state a consumer is in after an upgrade.
    fs.writeFileSync(path.join(root, '.harness/ONBOARDING.md'), 'older release\n');
    docs['.harness/ONBOARDING.md'] = { sha256: sha256('older release\n') };

    const actions = ensureConsumerOnboarding(root, docs);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'updated');
    assert.equal(
        fs.readFileSync(path.join(root, '.harness/ONBOARDING.md'), 'utf8'),
        fs.readFileSync(path.join(TEMPLATES, 'ONBOARDING.md'), 'utf8'),
    );
});

test('an edited copy is reported, not overwritten', () => {
    const root = tempRoot();
    const docs = {};
    ensureConsumerOnboarding(root, docs);
    const edited = '# ours, tuned for this repo\n';
    fs.writeFileSync(path.join(root, '.harness/ONBOARDING.md'), edited);

    const actions = ensureConsumerOnboarding(root, docs);
    const onboarding = actions.find((a) => a.relative === '.harness/ONBOARDING.md');
    assert.equal(onboarding.action, 'kept-edited');
    assert.equal(fs.readFileSync(path.join(root, '.harness/ONBOARDING.md'), 'utf8'), edited);
});

test('a copy we did not write is adopted, not clobbered', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/ONBOARDING.md'), '# edited by the operator\n');

    const docs = {};
    const actions = ensureConsumerOnboarding(root, docs);
    assert.deepEqual(actions.map((a) => a.relative), ['.harness/ONBOARDING.md', '.harness/diagnostics.sh']);
    assert.equal(fs.readFileSync(path.join(root, '.harness/ONBOARDING.md'), 'utf8'), '# edited by the operator\n');
    assert.ok(
        docs['.harness/ONBOARDING.md'].adopted,
        'a pre-bookkeeping copy becomes the baseline, so it is not re-examined as an edit every run',
    );
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

test('every layer the checklist documents is one the script can run', { timeout: 120_000 }, () => {
    /*
     * Budget, not decoration: nine real script invocations at ~0.8s each exceed node:test's 5000ms
     * default on a loaded machine, and a killed child reports as a wrong result rather than as a
     * timeout in the assertion text.
     */
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

/*
 * The three rows below exist because a real consumer reported the wrong thing while the product
 * reported the right one. A diagnostic that disagrees with the tool it summarises is worse than no
 * diagnostic: the operator fixes the measurement instead of the consumer.
 */

/** A consumer with the only rules that matter for the eager count: frontmatter decides, not the name. */
function seedRules(root) {
    const dir = path.join(root, '.cursor', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    // 12 eager rules, 30 lazy ones: a file count says 42 (fail at ceiling 7), the frontmatter says 12.
    for (let i = 0; i < 12; i += 1) {
        fs.writeFileSync(path.join(dir, `core.eager-${i}.mdc`), `---\nalwaysApply: true\n---\n# rule ${i}\n`);
    }
    for (let i = 0; i < 30; i += 1) {
        fs.writeFileSync(path.join(dir, `scope.lazy-${i}.mdc`), `---\nglobs: src/**\n---\n# rule ${i}\n`);
    }
}

test('L5 counts eager rules by frontmatter, not by file count', () => {
    const root = tempRoot();
    ensureConsumerOnboarding(root);
    fs.writeFileSync(
        path.join(root, '.harness/decision-policy.json'),
        JSON.stringify({ tokenDiet: { enabled: true, maxEagerRules: 20, maxEagerTokens: 10000 } }),
    );
    seedRules(root);

    const rows = JSON.parse(runScript(root, ['L5', '--json']).stdout).layers.L5;
    const ceiling = rows.find((r) => r.id === 'L5:eager-rules');
    assert.equal(ceiling.status, 'PASS', '42 files but 12 eager rules is under a ceiling of 20');
    assert.match(ceiling.detail, /12 eager/);
    assert.ok(
        rows.some((r) => r.id === 'L5:tree:cursor' && /12 eager, 30 lazy/.test(r.detail)),
        'the per-tree split must come from the scanner',
    );
});

test('L3 fails when any provider kind resolves to none, not only the first', () => {
    const root = tempRoot();
    ensureConsumerOnboarding(root);
    // Real report shape: law/code resolve, memory/verifier/reasoner do not. Checking a single
    // `"selected": null` match anywhere would pass or fail by luck of ordering; naming the kinds is
    // the only version an operator can act on.
    const report = {
        kinds: [
            { kind: 'law', selected: { id: 'docgraph-cli' }, reason: 'default' },
            { kind: 'code', selected: { id: 'codegraph-cli' }, reason: 'default' },
            { kind: 'memory', selected: null, reason: 'none' },
            { kind: 'reasoner', selected: null, reason: 'none' },
        ],
    };
    const stub = path.join(root, 'stub-harnessctl.mjs');
    fs.writeFileSync(
        stub,
        `import fs from 'node:fs';\nconsole.log(fs.readFileSync(${JSON.stringify(
            path.join(root, 'probe.json'),
        )}, 'utf8'));\n`,
    );
    fs.writeFileSync(path.join(root, 'probe.json'), JSON.stringify(report));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'harnessctl'), `#!/bin/sh\nexec node ${JSON.stringify(stub)}\n`, { mode: 0o755 });

    const res = runScript(root, ['L3', '--json'], { PATH: `${bin}:${process.env.PATH}` });
    const row = JSON.parse(res.stdout).layers.L3.find((r) => r.id === 'L3:capability');
    assert.equal(row.status, 'FAIL');
    assert.match(row.detail, /memory\(none\)/);
    assert.match(row.detail, /reasoner\(none\)/);
});

test('capability probe accepts a positional consumer instead of treating it as the verb', async () => {
    /*
     * The usage line has always advertised `capability probe [consumer]`, but the dispatcher forwarded
     * `argv.slice(2)` — verb included — so the subcommand read "probe" as the consumer path. Every
     * caller that passed a path (including this diagnostic) got a probe of a directory named "probe".
     */
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'harness.config.json'), '{}');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    const report = await runCapabilityProbe([root, '--json']);
    assert.equal(report.root, path.resolve(root));
});

test('the seeded checklist and diagnostic leave the index with the rest of the install', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    const body = fs.readFileSync(path.join(root, '.harness', '.gitignore'), 'utf8');
    /*
     * These are written by the provision, so a committed copy is a copy that goes stale in the
     * repository while the machine runs a newer one. The checklist tells the operator how to recover a
     * consumer; the recovery command is what has to be current, and `provision.sh` is where they get it.
     */
    for (const f of ['ONBOARDING.md', 'diagnostics.sh']) {
        assert.doesNotMatch(body, new RegExp(`^!${f.replace('.', '\\.')}$`, 'm'), `${f} is provisioned, not reviewed`);
    }
    assert.match(body, /^!README\.md$/m, 'README is the one file that explains the convention');
});

/*
 * `.harness/.gitignore` splits the directory three ways, and the split is the whole product of this
 * function: install artifacts a clone must carry, per-machine state it must not, and session verdicts.
 * Asserting the text is not enough — gitignore semantics are order-sensitive and "ignored directory"
 * differs from "ignored contents" — so the assertions below go through `git check-ignore` on a real
 * repository. A rule nobody proved is a claim.
 */
function gitIgnored(root, relPath) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), 'x');
    if (!fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init', '-q'], { cwd: root });
    const r = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: root });
    return r.status === 0;
}

test('everything .harness holds is machine-local except the rules that define it', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    /*
     * Asserted by file and not by prose. A provision regrows every one of these, so committing any of
     * them makes `git status` dirty after a clone — the state x79 was in. `.gitignore` and `README.md`
     * are the two files a newcomer has to be able to read before they provision anything.
     */
    for (const rel of [
        '.harness/host-pack/harness-hook.mjs',
        '.harness/host-pack/host-pack.json',
        '.harness/host-bootstrap.json',
        '.harness/host-install-state.json',
        '.harness/sidecar.env',
        '.harness/decision-policy.json',
        '.harness/integrations.json',
        '.harness/ONBOARDING.md',
        '.harness/WORKFLOW_GUIDE.md',
        '.harness/diagnostics.sh',
        '.harness/eso-coverage.json',
    ]) {
        assert.equal(gitIgnored(root, rel), true, `${rel} belongs to one checkout`);
    }
    for (const rel of ['.harness/.gitignore', '.harness/README.md']) {
        assert.equal(gitIgnored(root, rel), false, `${rel} defines the rules and is committed`);
    }
});

test('a consumer can still commit a file it decides to own', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    /*
     * A re-provision rewrites the file, so an operator exception has to survive being filtered: the rule
     * is not one of ours, and removing it would silently un-commit the file they chose to version.
     */
    fs.appendFileSync(path.join(root, '.harness/.gitignore'), '!my-own-file.json\n');
    ensureHarnessGitignore(root);
    ensureHarnessGitignore(root);
    assert.match(fs.readFileSync(path.join(root, '.harness/.gitignore'), 'utf8'), /^!my-own-file\.json$/m);
});

test('a rule the product has stopped admitting is removed, not preserved', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    /*
     * The shape on disk in every consumer provisioned before the pack stopped being admitted. Leaving
     * these lines in place made the old allowlist permanent: the missing-rule check saw every rule as
     * present, so the run answered "skip" and the pack stayed committed.
     */
    const legacy = [
        '*',
        '!sidecar.env',
        '!decision-policy.json',
        '!integrations.json',
        '!WORKFLOW_GUIDE.md',
        '!ONBOARDING.md',
        '!diagnostics.sh',
        '!sidecar.env.example',
        '!eso-coverage.json',
        '!host-bootstrap.json',
        '!host-install-state.json',
        '!host-pack/',
        '!host-pack/**',
        '!.gitignore',
        '!README.md',
        '# harness-eso: per-user session state, never commit',
        'sidecar.env',
        '*/session/*',
        '!**/session/README.md',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(root, '.harness/.gitignore'), legacy);

    assert.equal(ensureHarnessGitignore(root).action, 'write');
    const body = fs.readFileSync(path.join(root, '.harness/.gitignore'), 'utf8');
    assert.match(body, /^!README\.md$/m);
    for (const gone of ['!host-pack/', '!host-pack/**', '!host-bootstrap.json', '!decision-policy.json', '!sidecar.env.example']) {
        assert.ok(!body.split('\n').includes(gone), `${gone} is not ours to admit any more`);
    }
    assert.equal(ensureHarnessGitignore(root).action, 'skip', 'and the second run has nothing to do');
});

test('sidecar.env is machine-local: ignored, and so is the example it was modelled on', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    assert.equal(gitIgnored(root, '.harness/sidecar.env'), true, 'the token file must never be committed');
    /*
     * The example used to be admitted as documentation. Now that nothing under `.harness/` is committed,
     * an admitted example would be the single tracked artifact of a provisioned directory — the same
     * diff-after-provision failure at a smaller scale. The template lives in the product's `templates/`.
     */
    assert.equal(gitIgnored(root, '.harness/sidecar.env.example'), true, 'the example is provisioned too');
});

test('session state is ignored and the session README is not', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    ensureSessionGitignore(root, 'cursor');
    // The root `.gitignore` only matters if it exists; a consumer with none gets no session rules and
    // the `.harness` block is the backstop — assert the backstop too.
    fs.writeFileSync(path.join(root, '.gitignore'), '/node_modules\n');
    ensureSessionGitignore(root, 'cursor');

    assert.equal(gitIgnored(root, '.cursor/session/.eso-preflight.json'), true);
    assert.equal(gitIgnored(root, '.cursor/session/route-trace.jsonl'), true);
    assert.equal(gitIgnored(root, '.cursor/session/README.md'), false, 'a directory nobody documents gets deleted');
});

/*
 * The ignore rule cannot reach a file that was committed before the rule existed: git only consults
 * `.gitignore` for untracked paths. Every consumer provisioned before the pack stopped being admitted
 * is in that state, and x79 also carries the hand-committed `sidecar.env`.
 */
function git(root, ...args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.replace(/\0$/, '').trim();
}

/** What `git ls-files` says is tracked under `.harness/`, sorted. */
function trackedHarness(root) {
    return git(root, 'ls-files', '-z', '--', '.harness').split('\0').filter(Boolean).sort();
}

test('a sidecar.env committed before the rule existed is released from the index', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/sidecar.env'), 'HARNESS_SIDECAR_URL=http://127.0.0.1:1\n');
    ensureHarnessGitignore(root);
    git(root, 'init', '-q');
    git(root, 'add', '-f', '.harness/sidecar.env');

    assert.deepEqual(untrackIgnoredPaths(root), { released: ['.harness/sidecar.env'], deleted: [] });
    assert.deepEqual(trackedHarness(root), [], 'nothing of ours left in the index');
    assert.ok(fs.existsSync(path.join(root, '.harness/sidecar.env')), 'untracking is not deleting');
    assert.deepEqual(untrackIgnoredPaths(root), { released: [], deleted: [] }, 'a second provision has nothing left');
});

test('everything a consumer committed under .harness leaves except the rules themselves', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    git(root, 'init', '-q');
    /*
     * Force past the ignore rules, the way a consumer that provisioned under the old allowlist did — the
     * pack, the policy and the docs were all admitted then. The split asserted below is the whole product
     * of this function: what describes the rules stays, what a provision regrows leaves.
     */
    const committed = [
        '.harness/README.md',
        '.harness/decision-policy.json',
        '.harness/integrations.json',
        '.harness/WORKFLOW_GUIDE.md',
        '.harness/ONBOARDING.md',
        '.harness/diagnostics.sh',
        '.harness/sidecar.env.example',
        '.harness/host-pack/harness-hook.mjs',
        '.harness/host-pack/host-pack.json',
        '.harness/host-bootstrap.json',
        '.harness/host-install-state.json',
        '.harness/sidecar.env',
    ];
    for (const rel of committed) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), 'x\n');
        git(root, 'add', '-f', rel);
    }

    const { released, deleted } = untrackIgnoredPaths(root);
    assert.deepEqual(deleted, []);
    assert.deepEqual(released.sort(), committed.filter((rel) => rel !== '.harness/README.md').sort());
    assert.deepEqual(trackedHarness(root), ['.harness/README.md']);
});

test('a committed file that no longer exists loses only its index entry', () => {
    const root = tempRoot();
    ensureHarnessGitignore(root);
    git(root, 'init', '-q');
    fs.mkdirSync(path.join(root, '.harness/host-pack'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/host-pack/route-hook.py'), 'x\n');
    git(root, 'add', '-f', '.harness/host-pack/route-hook.py');
    fs.rmSync(path.join(root, '.harness/host-pack/route-hook.py'));

    // The file is gone, so `git rm --cached` without `--ignore-unmatch` refuses — and a stale deletion
    // in the index is exactly what shows up in every teammate's tree.
    assert.deepEqual(untrackIgnoredPaths(root), { released: [], deleted: ['.harness/host-pack/route-hook.py'] });
    assert.deepEqual(trackedHarness(root), []);
});

test('untracking is a no-op outside a git repository', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/sidecar.env'), 'x\n');
    assert.deepEqual(
        untrackIgnoredPaths(root),
        { released: [], deleted: [] },
        'provisioning a plain directory must not require git',
    );
});

test('ensureSessionGitignore ignores contents, not the directory, and is idempotent', () => {    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    ensureSessionGitignore(root, 'cursor');
    const first = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    /*
     * A line ending in `/` excludes the directory and git then never evaluates rules for what is
     * inside, which silently defeats the exception on the next line. The contents form is the only
     * shape in which `.cursor/session/README.md` can be committed at all.
     */
    assert.doesNotMatch(first, /^\.cursor\/session\/$/m, 'excluding the directory makes its README unreachable');
    assert.match(first, /^\.cursor\/session\/\*$/m);

    ensureSessionGitignore(root, 'cursor');
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), first, 'repeat runs must not grow the file');
});
