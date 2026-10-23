/**
 * Hard blockers: the findings that may stop a step, and the one place that says which ones.
 *
 * Finding #2 of the advance program: a 0–1 score never protected anything, because a threshold that
 * is tuned to pass is not a gate. A blocker is different in kind — a named, reproducible finding from
 * a check (`contract`, `project`, `migration`) with a `file`/`path` you can open. Nothing here scores,
 * sums or ranks; if a finding is acceptable, the decision is recorded **at the source**
 * (`/* isolation:global *\/`, `/* breaking:approved *\/`), not by lowering a threshold.
 *
 * The split is deliberate:
 *
 *   - `loadCheckInputs` reads what a consumer declared (paths, tables) and reports what it could not
 *     read as `errors`, never as silence;
 *   - `hardBlockersFromChecks` turns check output into blockers. Every finding a check reports is
 *     hard, because the checks already exclude the marked exceptions;
 *   - `rejectOnHardBlockers` is the predicate a host passes to `rejectOn`, so a host that cannot
 *     read its own declared inputs can opt into fail-closed (B1).
 */
import fs from 'node:fs';
import path from 'node:path';

import { diffContracts } from './contract-diff.mjs';
import { checkIsolationFiles } from './isolation-check.mjs';
import { checkMigrationFiles } from './migration-check.mjs';

/**
 * @typedef {{ source: 'contract'|'project'|'migration', kind: string, ref: string, detail: string, table?: string }} HardBlocker
 */

function readText(root, rel, errors, source) {
    const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
    try {
        return { file: rel, content: fs.readFileSync(file, 'utf8') };
    } catch (err) {
        errors.push({ source, detail: `cannot read ${rel}: ${err.message}` });
        return null;
    }
}

function readJson(root, value, errors, source, label) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) {
        errors.push({ source, detail: `${label} must be a path or a parsed object` });
        return null;
    }
    const read = readText(root, value, errors, source);
    if (!read) return null;
    try {
        return JSON.parse(read.content);
    } catch (err) {
        errors.push({ source, detail: `${label} is not JSON: ${err.message}` });
        return null;
    }
}

/**
 * Read a `checks` declaration into check inputs. Paths are relative to `root`.
 *
 * @param {string} root
 * @param {{ contract?: { before?: string|object, after?: string|object, direction?: 'response'|'request' },
 *           project?: { files?: string[], tables?: string[] },
 *           migration?: { files?: string[] } }} [checks]
 * @returns {{ contract: object|null, project: { files: object[], scopedTables: string[] }|null,
 *             migration: { files: object[] }|null, errors: Array<{source:string, detail:string}> }}
 */
export function loadCheckInputs(root = process.cwd(), checks = {}) {
    const errors = [];
    let contract = null;
    if (checks.contract) {
        const before = readJson(root, checks.contract.before, errors, 'contract', 'contract.before');
        const after = readJson(root, checks.contract.after, errors, 'contract', 'contract.after');
        if (before && after) contract = { before, after, direction: checks.contract.direction };
    }

    let project = null;
    if (checks.project) {
        const tables = (checks.project.tables ?? []).map((t) => String(t).trim()).filter(Boolean);
        if (!tables.length) {
            errors.push({ source: 'project', detail: 'project.tables is required: an isolation check without tables checks nothing' });
        } else {
            const files = [];
            for (const rel of checks.project.files ?? []) {
                const read = readText(root, rel, errors, 'project');
                if (read) files.push(read);
            }
            // An array, not a Set: `checkIsolation` normalises with `.map`, which a Set lacks.
            project = { files, scopedTables: tables };
        }
    }

    let migration = null;
    if (checks.migration) {
        const files = [];
        for (const rel of checks.migration.files ?? []) {
            const read = readText(root, rel, errors, 'migration');
            if (read) files.push(read);
        }
        migration = { files };
    }

    return { contract, project, migration, errors };
}

/**
 * Turn check output into blockers. Deterministic order: contract, project, migration — the same order
 * the CLI prints them, so two runs on one tree produce one list.
 *
 * @param {{ contract?: object|null, project?: object|null, migration?: object|null }} inputs
 * @returns {{ blockers: HardBlocker[], checked: object }}
 */
export function hardBlockersFromChecks(inputs = {}) {
    /** @type {HardBlocker[]} */
    const blockers = [];
    const checked = { contract: 0, project: 0, migration: 0 };

    if (inputs.contract) {
        const { breaking, checked: routes } = diffContracts(inputs.contract.before, inputs.contract.after, {
            direction: inputs.contract.direction,
        });
        checked.contract = routes ?? 0;
        for (const finding of breaking) {
            blockers.push({ source: 'contract', kind: finding.kind, ref: finding.path, detail: finding.detail });
        }
    }

    if (inputs.project) {
        const { files, findings } = checkIsolationFiles(inputs.project.files, { scopedTables: inputs.project.scopedTables });
        checked.project = files ?? 0;
        for (const finding of findings) {
            blockers.push({
                source: 'project',
                kind: finding.kind,
                ref: finding.file,
                table: finding.table,
                detail: finding.detail,
            });
        }
    }

    if (inputs.migration) {
        const { files, findings } = checkMigrationFiles(inputs.migration.files);
        checked.migration = files ?? 0;
        for (const finding of findings) {
            blockers.push({ source: 'migration', kind: finding.kind, ref: finding.file, detail: finding.detail });
        }
    }

    return { blockers, checked };
}

function blockerList(result) {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.hardBlockers) ? result.hardBlockers : [];
}

/**
 * Attach blockers (and whatever could not be read) to a preflight result without touching the rest.
 *
 * @param {object} result
 * @param {HardBlocker[]} blockers
 * @param {Array<{source:string, detail:string}>} [errors]
 */
export function withHardBlockers(result, blockers = [], errors = []) {
    if (!result || result.skipped) return result;
    return { ...result, hardBlockers: blockers, checkErrors: errors };
}

/**
 * The predicate a host passes as `rejectOn`. Default is blockers only; `{ strict: true }` also
 * rejects when a declared check could not be read (B1: a guard that cannot decide denies).
 *
 * @param {object|HardBlocker[]} result
 * @param {{ strict?: boolean }} [options]
 * @returns {boolean}
 */
export function rejectOnHardBlockers(result, options = {}) {
    if (blockerList(result).length) return true;
    return options.strict === true && Array.isArray(result?.checkErrors) && result.checkErrors.length > 0;
}

/** Convenience for a host that only has the result in hand. */
export function hasHardBlockers(result) {
    return blockerList(result).length > 0;
}
