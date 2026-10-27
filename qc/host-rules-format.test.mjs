import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureConsumerRules, ruleExtensionForTree } from '../packages/harness-foundation/src/host-install.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROFILES_DIR = path.join(REPO_ROOT, 'profiles');
const TEMPLATES_DIR = path.join(PROFILES_DIR, 'templates', 'rules');

const RULE_STEMS = [
    'core.law-gate',
    'core.conversation-hygiene',
    'core.pipeline-gate',
    'core.scope-fallback',
    'workflow.agentic-factory',
    'workflow.qc-runtime',
    'delivery.workflow',
];

function withProfiles(fn) {
    const prev = process.env.HARNESS_PROFILES_DIR;
    process.env.HARNESS_PROFILES_DIR = PROFILES_DIR;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PROFILES_DIR;
        else process.env.HARNESS_PROFILES_DIR = prev;
    }
}

function scratchTree(treeKey) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `eso-rules-${treeKey}-`));
    fs.mkdirSync(path.join(root, `.${treeKey}`, 'rules'), { recursive: true });
    return root;
}

test('ruleExtensionForTree: only the cursor tree uses .mdc', () => {
    assert.equal(ruleExtensionForTree('cursor'), '.mdc');
    assert.equal(ruleExtensionForTree('agents'), '.md');
    assert.equal(ruleExtensionForTree('claude'), '.md');
});

/*
 * INV-05 regression (fineso 2026-10-24). `ensureConsumerRules` used to write the `.mdc` template
 * into `.agents/rules/` *and* copy its bytes to a `.md` name, so one call produced 14 files
 * (7 `.mdc` + 7 `.md`) and the `.md` was a byte-for-byte copy rather than an Antigravity rule.
 * Both halves are asserted: a `.md`-counts-7 check passes on the broken code.
 */
for (const treeKey of ['cursor', 'agents', 'claude']) {
    test(`ensureConsumerRules seeds ${treeKey} with exactly one format`, () => {
        withProfiles(() => {
            const root = scratchTree(treeKey);
            try {
                ensureConsumerRules(root, treeKey);
                const dir = path.join(root, `.${treeKey}`, 'rules');
                const files = fs.readdirSync(dir);
                const ext = ruleExtensionForTree(treeKey);

                const wrong = files.filter((f) => f.endsWith(ext === '.md' ? '.mdc' : '.md'));
                assert.deepEqual(wrong, [], `${treeKey} tree must carry no ${ext === '.md' ? '.mdc' : '.md'} files`);

                for (const stem of RULE_STEMS) {
                    assert.ok(fs.existsSync(path.join(dir, `${stem}${ext}`)), `${stem}${ext} seeded in ${treeKey}`);
                    // the other format must not exist under any name
                    assert.ok(!fs.existsSync(path.join(dir, `${stem}.mdc`)) || treeKey === 'cursor');
                }
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });
}

test('ensureConsumerRules: the .md a consumer receives is not a copy of the .mdc template', () => {
    withProfiles(() => {
        const root = scratchTree('agents');
        try {
            ensureConsumerRules(root, 'agents');
            const dir = path.join(root, '.agents', 'rules');
            for (const stem of RULE_STEMS) {
                const seeded = fs.readFileSync(path.join(dir, `${stem}.md`), 'utf8');
                const mechanism = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.mdc`), 'utf8');
                assert.notEqual(seeded, mechanism, `${stem}.md must not be byte-identical to ${stem}.mdc`);
                assert.match(seeded, /^---\n/, `${stem}.md keeps its own frontmatter`);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('ensureConsumerRules is idempotent and never overwrites consumer-authored rules', () => {
    withProfiles(() => {
        const root = scratchTree('agents');
        try {
            ensureConsumerRules(root, 'agents');
            const target = path.join(root, '.agents', 'rules', 'core.law-gate.md');
            fs.writeFileSync(target, '# consumer authored\n');

            const second = ensureConsumerRules(root, 'agents');
            assert.equal(second.length, 0, 'nothing to create on a fully seeded tree');
            assert.equal(fs.readFileSync(target, 'utf8'), '# consumer authored\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('ensureConsumerRules reports a skipped rule instead of substituting the other format', () => {
    withProfiles(() => {
        const emptyProfiles = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-rules-empty-'));
        const root = scratchTree('agents');
        try {
            // templates dir exists but ships only .mdc — the old code would have copied it to .md.
            fs.mkdirSync(path.join(emptyProfiles, 'templates', 'rules'), { recursive: true });
            const mdcOnly = path.join(emptyProfiles, 'templates', 'rules', 'core.law-gate.mdc');
            fs.copyFileSync(path.join(TEMPLATES_DIR, 'core.law-gate.mdc'), mdcOnly);

            process.env.HARNESS_PROFILES_DIR = emptyProfiles;
            const actions = ensureConsumerRules(root, 'agents');

            const dir = path.join(root, '.agents', 'rules');
            assert.deepEqual(fs.readdirSync(dir), [], 'nothing written when no .md template exists');
            const skipped = actions.filter((a) => a.action === 'skipped');
            assert.ok(skipped.length >= RULE_STEMS.length, 'every missing .md template is reported');
            assert.ok(skipped.every((a) => a.relative.endsWith('.md')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(emptyProfiles, { recursive: true, force: true });
        }
    });
});
