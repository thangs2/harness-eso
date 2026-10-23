import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkGuardFreshness } from '../../harness-eso-core/src/guard-freshness.mjs';
import { syncConsumerGuards } from './host-install.mjs';

/**
 * G-17: a consumer's Python guards are copied **once** and never rewritten, and H1 only asked "is a
 * guard wired". Atrievefin, 2026-10-23: `./provision.sh --force` reported 13 created / 2 updated,
 * `verify host` reported PASS H1, and both guard files were byte-identical to a build predating the
 * deny-message fix — so the operator was told the consumer had the new gate and it did not.
 *
 * Two halves are pinned here: the reader (`checkGuardFreshness`) must not call a stale guard current,
 * and the writer (`syncConsumerGuards`) must not lose an operator's edits while doing so.
 */
const TEMPLATE_WRITE = `#!/usr/bin/env python3
import json, sys

def deny(msg):
    print(json.dumps({"permissionDecision": "deny", "permissionDecisionReason": msg}))

def eso_verdict():
    return {}

def deny_eso_message():
    return "new"

def main():
    deny("x")

if __name__ == "__main__":
    main()
`;

function fixture({ templateWrite = TEMPLATE_WRITE, tree = 'cursor', guardText } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g17-'));
    const templates = path.join(root, '_templates');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'guard-write.py'), templateWrite);
    fs.writeFileSync(path.join(templates, 'guard-shell.py'), TEMPLATE_WRITE.replace('deny_eso_message', 'shell_gate'));
    if (tree) {
        fs.mkdirSync(path.join(root, `.${tree}`, 'hooks'), { recursive: true });
        fs.writeFileSync(path.join(root, `.${tree}`, 'hooks.json'), JSON.stringify({ hooks: {} }));
        fs.writeFileSync(
            path.join(root, `.${tree}`, 'hooks', 'guard-write.py'),
            guardText ?? templateWrite,
        );
    }
    return { root, templates };
}

test('G-17: a guard identical to the template is `current`', () => {
    const { root, templates } = fixture();
    const res = checkGuardFreshness(root, { templatesDir: templates });
    assert.equal(res.status, 'current', res.detail);
    assert.deepEqual(res.behind, []);
});

test('G-17: the pre-fix guard is `stale`, and the report names what it is missing', () => {
    const old = TEMPLATE_WRITE.replace('def deny_eso_message():\n    return "new"\n', '');
    const { root, templates } = fixture({ guardText: old });
    const res = checkGuardFreshness(root, { templatesDir: templates });
    assert.equal(res.status, 'stale');
    assert.equal(res.behind.length, 1);
    assert.equal(res.behind[0].file, 'guard-write.py');
    // The consequence must be the sentence an operator acts on, not "differs".
    assert.match(res.behind[0].consequence, /G-08\/G-12/);
    assert.match(res.detail, /colder|older gate/);
});

test('G-17: a wired tree with no guard is `not-applied`, not `current`', () => {
    const { root, templates } = fixture({ tree: null });
    const res = checkGuardFreshness(root, { templatesDir: templates });
    assert.equal(res.status, 'not-applied');
});

test('G-17: an operator-owned guard is reported, not treated as a broken host', () => {
    const custom = `${TEMPLATE_WRITE}\ndef team_gate(rel):\n    return rel.startswith("vendors/")\n`;
    const { root, templates } = fixture({ guardText: custom });
    const res = checkGuardFreshness(root, { templatesDir: templates });
    assert.equal(res.status, 'customised');
    assert.deepEqual(res.customised, ['cursor:guard-write.py']);
    assert.match(res.detail, /operator-owned/);
});

test('G-17: sync un-stales a consumer, keeps the old file as a backup, and is quiet on a second run', () => {
    const old = TEMPLATE_WRITE.replace('def deny_eso_message():\n    return "new"\n', '');
    const { root, templates } = fixture({ guardText: old });
    process.env.HARNESS_PROFILES_DIR = path.dirname(templates); // templates live at <dir>/templates/hooks
    const realTemplates = path.join(root, 'profiles', 'templates', 'hooks');
    fs.rmSync(path.join(root, '_templates'), { recursive: true, force: true });
    fs.mkdirSync(realTemplates, { recursive: true });
    fs.writeFileSync(path.join(realTemplates, 'guard-write.py'), TEMPLATE_WRITE);
    process.env.HARNESS_PROFILES_DIR = path.join(root, 'profiles');

    try {
        const first = syncConsumerGuards(root, { treeKeys: ['cursor'] });
        const updated = first.actions.find((a) => a.file === '.cursor/hooks/guard-write.py');
        assert.equal(updated.action, 'updated');
        assert.ok(updated.backup, 'the replaced file is backed up');
        assert.ok(fs.existsSync(path.join(root, updated.backup)), 'the backup exists on disk');
        assert.equal(checkGuardFreshness(root).status, 'current');

        const second = syncConsumerGuards(root, { treeKeys: ['cursor'] });
        assert.equal(
            second.actions.find((a) => a.file === '.cursor/hooks/guard-write.py').action,
            'current',
            'a second run must not churn the timestamp',
        );
    } finally {
        delete process.env.HARNESS_PROFILES_DIR;
    }
});

test('G-17: sync refuses to overwrite an operator-owned guard unless forced', () => {
    const custom = `${TEMPLATE_WRITE}\ndef team_gate(rel):\n    return False\n`;
    const { root } = fixture({ guardText: custom });
    fs.mkdirSync(path.join(root, 'profiles', 'templates', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profiles', 'templates', 'hooks', 'guard-write.py'), TEMPLATE_WRITE);
    process.env.HARNESS_PROFILES_DIR = path.join(root, 'profiles');
    try {
        const skipped = syncConsumerGuards(root, { treeKeys: ['cursor'] });
        const a = skipped.actions.find((x) => x.file === '.cursor/hooks/guard-write.py');
        assert.equal(a.action, 'skipped');
        assert.match(a.reason, /team_gate|operator-owned/);
        assert.match(fs.readFileSync(path.join(root, '.cursor/hooks/guard-write.py'), 'utf8'), /team_gate/);

        const forced = syncConsumerGuards(root, { treeKeys: ['cursor'], force: true });
        assert.equal(forced.actions.find((x) => x.file === '.cursor/hooks/guard-write.py').action, 'updated');
        assert.doesNotMatch(fs.readFileSync(path.join(root, '.cursor/hooks/guard-write.py'), 'utf8'), /team_gate/);
    } finally {
        delete process.env.HARNESS_PROFILES_DIR;
    }
});
