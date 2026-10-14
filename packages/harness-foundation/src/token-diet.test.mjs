import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    estimateTokens,
    parseFrontmatter,
    scanTokenDiet,
} from './token-diet.mjs';

test('estimateTokens calculates reasonable token approximations', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    // 38 characters ~ 10 tokens
    assert.equal(estimateTokens('a'.repeat(38)), 10);
});

test('parseFrontmatter extracts YAML frontmatter fields', () => {
    const content = `---
alwaysApply: true
globs: [*.ts, *.js]
description: A test rule
---
# Rule Title`;
    const fm = parseFrontmatter(content);
    assert.equal(fm.alwaysApply, true);
    assert.deepEqual(fm.globs, ['*.ts', '*.js']);
    assert.equal(fm.description, 'A test rule');

    assert.deepEqual(parseFrontmatter('# No frontmatter'), {});
});

test('scanTokenDiet evaluates eager budget, lazy rules and conflicts in temp workspace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-test-'));
    try {
        const cursorRulesDir = path.join(tmp, '.cursor', 'rules');
        fs.mkdirSync(cursorRulesDir, { recursive: true });

        // Eager rule
        fs.writeFileSync(
            path.join(cursorRulesDir, 'core.eager.mdc'),
            `---\nalwaysApply: true\n---\n# Eager rule\n`
        );

        // Lazy rule
        fs.writeFileSync(
            path.join(cursorRulesDir, 'lazy.scoped.mdc'),
            `---\nalwaysApply: false\nglobs: src/**\n---\n# Lazy rule\n`
        );

        // Conflict rule: both alwaysApply: true and globs
        fs.writeFileSync(
            path.join(cursorRulesDir, 'conflict.broken.mdc'),
            `---\nalwaysApply: true\nglobs: src/**\n---\n# Broken rule\n`
        );

        // Root harness file
        fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# AGENTS law\n');

        const report = scanTokenDiet(tmp, {
            tree: 'cursor',
            policy: { tokenDiet: { enabled: true, maxEagerRules: 2, maxEagerTokens: 5000 } },
        });

        assert.equal(report.status, 'fail'); // due to conflict
        assert.equal(report.trees.cursor.conflicts.length, 1);
        assert.equal(report.trees.cursor.conflicts[0].file, '.cursor/rules/conflict.broken.mdc');
        assert.equal(report.trees.cursor.assertions.lazyGlobs.pass, true);
        assert.equal(report.trees.cursor.summary.eagerRulesCount, 2); // core.eager + conflict.broken
        assert.equal(report.trees.cursor.summary.lazyRulesCount, 1); // lazy.scoped
        assert.equal(report.trees.cursor.summary.harnessFilesCount, 1); // AGENTS.md
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTokenDiet passes when all rules conform to budget and frontmatter rules', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-pass-'));
    try {
        const cursorRulesDir = path.join(tmp, '.cursor', 'rules');
        fs.mkdirSync(cursorRulesDir, { recursive: true });

        fs.writeFileSync(
            path.join(cursorRulesDir, 'core.eager.mdc'),
            `---\nalwaysApply: true\n---\n# Eager rule\n`
        );
        fs.writeFileSync(
            path.join(cursorRulesDir, 'lazy.rule.mdc'),
            `---\nalwaysApply: false\nglobs: src/**\n---\n# Lazy rule\n`
        );
        fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# Short AGENTS\n');

        const report = scanTokenDiet(tmp, {
            tree: 'cursor',
            policy: { tokenDiet: { enabled: true, maxEagerRules: 6, maxEagerTokens: 5000 } },
        });

        assert.equal(report.status, 'pass');
        assert.equal(report.trees.cursor.assertions.ruleCount.pass, true);
        assert.equal(report.trees.cursor.assertions.tokenBudget.pass, true);
        assert.equal(report.trees.cursor.assertions.frontmatterIntegrity.pass, true);
        assert.equal(report.trees.cursor.assertions.lazyGlobs.pass, true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
