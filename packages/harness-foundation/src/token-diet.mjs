import fs from 'node:fs';
import path from 'node:path';
import { loadDecisionPolicyForCwd } from './policy-load.mjs';

import { estimateTokens } from './token-estimate.mjs';

/*
 * The estimator lives in `token-estimate.mjs` so a module that only needs the division (the host
 * pack's surface check) does not bundle this scanner. Imported for local use and re-exported, so
 * `token-diet` stays the obvious import and there is still exactly one definition (A1).
 *
 * Not `export { estimateTokens } from './token-estimate.mjs'`: that re-exports without creating a
 * local binding, so every call inside this module would be `undefined` — and the scan swallows the
 * TypeError, which reports zero rules instead of failing.
 */
export { estimateTokens };

/**
 * Parse simple YAML frontmatter between --- and ---.
 * @param {string} content
 * @returns {Record<string, any>}
 */
export function parseFrontmatter(content) {
    if (!content.startsWith('---')) return {};
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx === -1) return {};
    const header = content.slice(3, endIdx).trim();
    const data = {};
    for (const line of header.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        let val = line.slice(colon + 1).trim();
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (val.startsWith('[') && val.endsWith(']')) {
            val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
        }
        data[key] = val;
    }
    return data;
}

const IGNORED_RULE_NAMES = new Set([
    'readme.md',
    'index.md',
    'license.md',
    'contributing.md',
]);

function shouldIgnoreFile(fileName) {
    return IGNORED_RULE_NAMES.has(fileName.toLowerCase()) || fileName.startsWith('.');
}

/**
 * Scan a single IDE tree (cursor or agents).
 *
 * @param {string} root
 * @param {'cursor'|'agents'} tree
 * @param {object} budget
 * @returns {object}
 */
function scanSingleTree(root, tree, budget) {
    const isCursor = tree === 'cursor';
    const ruleDir = isCursor
        ? path.join(root, '.cursor', 'rules')
        : path.join(root, '.agents', 'rules');

    const extensions = isCursor ? ['.mdc'] : ['.md', '.mdc'];
    const harnessFilesList = isCursor
        ? ['AGENTS.md', '.cursorrules', '.cursor/instructions.md']
        : ['AGENTS.md', 'GEMINI.md'];

    const eagerRules = [];
    const lazyRules = [];
    const conflicts = [];
    const missingGlobs = [];
    const ruleStemsSeen = new Set();

    if (fs.existsSync(ruleDir)) {
        try {
            const files = fs.readdirSync(ruleDir);
            for (const file of files) {
                if (shouldIgnoreFile(file)) continue;
                if (!extensions.some((ext) => file.endsWith(ext))) continue;

                const ruleStem = file.replace(/\.(md|mdc)$/, '');
                if (ruleStemsSeen.has(ruleStem)) continue;
                ruleStemsSeen.add(ruleStem);

                const fullPath = path.join(ruleDir, file);
                const relPath = path.relative(root, fullPath);
                const content = fs.readFileSync(fullPath, 'utf8');
                const fm = parseFrontmatter(content);
                const bytes = Buffer.byteLength(content, 'utf8');
                const tokens = estimateTokens(content);

                const hasAlwaysApplyTrue = fm.alwaysApply === true;
                const hasAlwaysApplyFalse = fm.alwaysApply === false;
                const hasGlobs = Boolean(
                    fm.globs && (Array.isArray(fm.globs) ? fm.globs.length > 0 : String(fm.globs).trim().length > 0)
                );

                if (hasAlwaysApplyTrue && hasGlobs) {
                    conflicts.push({
                        file: relPath,
                        reason: 'Rule declares both alwaysApply: true and globs',
                    });
                }

                if (hasAlwaysApplyTrue || (!hasGlobs && !hasAlwaysApplyFalse)) {
                    eagerRules.push({
                        name: file,
                        path: relPath,
                        tree,
                        bytes,
                        tokens,
                        alwaysApply: true,
                        description: fm.description || '',
                    });
                } else {
                    if (!hasGlobs) {
                        missingGlobs.push({
                            file: relPath,
                            reason: 'Lazy rule declared without globs pattern',
                        });
                    }
                    lazyRules.push({
                        name: file,
                        path: relPath,
                        tree,
                        bytes,
                        tokens,
                        globs: fm.globs,
                        description: fm.description || '',
                    });
                }
            }
        } catch {
            // Ignore access errors
        }
    }

    const harnessFiles = [];
    for (const h of harnessFilesList) {
        const fullPath = path.join(root, h);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                harnessFiles.push({
                    name: h,
                    path: h,
                    bytes: Buffer.byteLength(content, 'utf8'),
                    tokens: estimateTokens(content),
                });
            } catch {
                // Ignore
            }
        }
    }

    const totalEagerRuleTokens = eagerRules.reduce((sum, r) => sum + r.tokens, 0);
    const totalEagerRuleBytes = eagerRules.reduce((sum, r) => sum + r.bytes, 0);
    const totalHarnessTokens = harnessFiles.reduce((sum, h) => sum + h.tokens, 0);
    const totalHarnessBytes = harnessFiles.reduce((sum, h) => sum + h.bytes, 0);

    const totalEagerTokens = totalEagerRuleTokens + totalHarnessTokens;
    const totalEagerBytes = totalEagerRuleBytes + totalHarnessBytes;

    const assertions = {
        ruleCount: {
            pass: eagerRules.length <= budget.maxEagerRules,
            actual: eagerRules.length,
            budget: budget.maxEagerRules,
        },
        tokenBudget: {
            pass: totalEagerTokens <= budget.maxEagerTokens,
            actual: totalEagerTokens,
            budget: budget.maxEagerTokens,
        },
        frontmatterIntegrity: {
            pass: conflicts.length === 0,
            conflicts,
        },
        lazyGlobs: {
            pass: missingGlobs.length === 0,
            missing: missingGlobs,
        },
    };

    let status = 'pass';
    if (!assertions.frontmatterIntegrity.pass || !assertions.lazyGlobs.pass) {
        status = 'fail';
    } else if (!assertions.ruleCount.pass || !assertions.tokenBudget.pass) {
        status = 'warn';
    }

    return {
        tree,
        status,
        assertions,
        summary: {
            eagerRulesCount: eagerRules.length,
            lazyRulesCount: lazyRules.length,
            totalRulesCount: eagerRules.length + lazyRules.length,
            harnessFilesCount: harnessFiles.length,
            totalEagerTokens,
            totalEagerBytes,
            budget,
        },
        eagerRules,
        lazyRules,
        harnessFiles,
        conflicts,
        missingGlobs,
    };
}

/**
 * Scan consumer workspace for token-diet compliance.
 *
 * @param {string} root - Path to consumer workspace root.
 * @param {object} [opts] - Options.
 * @param {'all'|'cursor'|'agents'} [opts.tree='all'] - Scope to specific IDE tree.
 * @param {object} [opts.policy] - Explicit decision policy override.
 * @returns {object} Token diet audit report.
 */
export function scanTokenDiet(root = process.cwd(), opts = {}) {
    const policyResult = opts.policy ? { policy: opts.policy } : loadDecisionPolicyForCwd(root);
    const tokenDietCfg = policyResult?.policy?.tokenDiet || {
        enabled: true,
        maxEagerRules: 7,
        maxEagerTokens: 5000,
    };

    const budget = {
        maxEagerRules: Number(tokenDietCfg.maxEagerRules ?? 7),
        maxEagerTokens: Number(tokenDietCfg.maxEagerTokens ?? 5000),
    };

    const targetTree = opts.tree || 'all';
    const trees = {};

    if (targetTree === 'all' || targetTree === 'cursor') {
        trees.cursor = scanSingleTree(root, 'cursor', budget);
    }
    if (targetTree === 'all' || targetTree === 'agents') {
        trees.agents = scanSingleTree(root, 'agents', budget);
    }

    // Roll up overall status
    const allReports = Object.values(trees);
    let overallStatus = 'pass';
    if (allReports.some((r) => r.status === 'fail')) {
        overallStatus = 'fail';
    } else if (allReports.some((r) => r.status === 'warn')) {
        overallStatus = 'warn';
    }

    // Default primary tree report for flat consumption
    const primary = trees.cursor || trees.agents || allReports[0];

    return {
        root,
        enabled: tokenDietCfg.enabled !== false,
        status: overallStatus,
        tree: targetTree,
        budget,
        trees,
        // Flat legacy fields for backward-compatibility with primary tree
        summary: primary.summary,
        assertions: primary.assertions,
        eagerRules: primary.eagerRules,
        lazyRules: primary.lazyRules,
        harnessFiles: primary.harnessFiles,
        conflicts: primary.conflicts,
        missingGlobs: primary.missingGlobs,
    };
}
