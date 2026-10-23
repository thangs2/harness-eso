import fs from 'node:fs';
import path from 'node:path';
import {
    applyHostProfiles,
    buildProvisionPlan,
    deepMergePolicyObjects,
    defaultPlugins,
    defaultProjectDraft,
} from './project-registry.mjs';
import { scanTokenDiet } from './token-diet.mjs';
import { normalizePort } from './observe-port.mjs';
import { writeJsonAtomic } from './workspace-store.mjs';

const POLICY_RELATIVE = '.harness/decision-policy.json';

/**
 * Content owned by `applyHostProfiles` (hook bins, merged `hooks.json`, `sidecar.env`,
 * `host-bootstrap.json`), so this loop must not touch it — it would write a placeholder
 * that host-install immediately overwrites.
 */
function isHostInstallRelative(relative) {
    return (
        relative.endsWith('hooks.json') ||
        relative.endsWith('sidecar.env') ||
        relative.includes('/hooks/harness-eso/') ||
        relative.startsWith('.harness/host-pack') ||
        relative === '.harness/host-bootstrap.json' ||
        relative === '.harness/host-install-state.json'
    );
}

/**
 * Write the plan's JSON files. `runtime` files (session artifacts) are produced by the
 * hooks; host-install files are produced by `applyHostProfiles`.
 * @param {ReturnType<typeof buildProvisionPlan>} plan
 */
function writePlanFiles(plan) {
    const results = [];
    for (const f of plan.files) {
        if (f.action === 'runtime') {
            results.push({ relative: f.relative, status: 'deferred', reason: 'runtime' });
            continue;
        }
        if (isHostInstallRelative(f.relative)) {
            results.push({ relative: f.relative, status: 'deferred', reason: 'host-install' });
            continue;
        }
        const exists = fs.existsSync(f.path);
        if (f.action === 'skip') {
            results.push({ relative: f.relative, status: 'skipped', reason: 'exists' });
            continue;
        }
        if (f.relative === POLICY_RELATIVE) {
            // Merged, never force-written: the plan's keys ARE re-applied (the wizard's
            // plugin/profile choices are authoritative), but keys the plan does not define
            // — operator tuning added by hand — survive. A forced rewrite would drop them.
            fs.mkdirSync(path.dirname(f.path), { recursive: true });
            const prior = exists ? JSON.parse(fs.readFileSync(f.path, 'utf8')) : {};
            writeJsonAtomic(f.path, deepMergePolicyObjects(prior, f.preview));
            results.push({ relative: f.relative, status: exists ? 'merged' : 'created' });
            continue;
        }
        if (f.action === 'create-if-missing' && exists) {
            results.push({ relative: f.relative, status: 'skipped', reason: 'exists' });
            continue;
        }
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        writeJsonAtomic(f.path, f.preview);
        results.push({ relative: f.relative, status: exists ? 'updated' : 'created' });
    }
    return results;
}

/**
 * Canonical consumer bootstrap — only supported way to create harness files on a repo (e.g. x79).
 * @param {object} project harness-console project JSON shape
 * @param {string} profilesDir ship unit profiles/
 * @param {string} registryPath
 * @param {{ dryRun?: boolean, force?: boolean, verify?: boolean }} opts
     *      * `force` rewrites an existing `harness.config.json` (see `provisionAction`).
 *   `observePort` pins the port instead of claiming one from the workspace.
 */
export function initProfile(project, profilesDir, registryPath, opts = {}) {
    const plan = buildProvisionPlan(project, profilesDir, registryPath, {
        force: opts.force === true,
        observePort: opts.observePort ?? project.observe?.port,
    });
    if (!plan.root) {
        throw new Error('consumer root is required (agentRepo.root)');
    }
    if (!plan.hostProfiles?.length) {
        throw new Error('init profile requires full host pack (hostProfiles empty)');
    }

    if (opts.dryRun) {
        return {
            ok: true,
            dryRun: true,
            root: plan.root,
            hostProfileIds: plan.hostProfileIds,
            files: plan.files.map((f) => ({
                relative: f.relative,
                action: f.action,
                group: f.group,
                exists: fs.existsSync(f.path),
                preview: f.preview,
            })),
        };
    }

    const results = writePlanFiles(plan);

    // `plan.observePort` is the port `buildProvisionPlan` claimed from the workspace. Reading
    // `project.observe?.port || 8792` here would re-open the second registry this change removes.
    const host = applyHostProfiles(plan.root, plan.hostProfiles, {
        observePort: plan.observePort,
        verify: opts.verify,
    });
    for (const a of host.actions) {
        results.push({ relative: a.relative, status: 'created', reason: a.action });
    }

    const diet = scanTokenDiet(plan.root);

    return {
        ok: true,
        root: plan.root,
        hostProfileIds: plan.hostProfileIds,
        files: results,
        observePort: plan.observePort,
        observeUrl: `http://127.0.0.1:${plan.observePort}`,
        tokenDiet: {
            status: diet.status,
            eagerRulesCount: diet.summary.eagerRulesCount,
            totalEagerTokens: diet.summary.totalEagerTokens,
            budget: diet.summary.budget,
        },
    };
}

/**
 * Build a project document for CLI `init profile` without Console wizard.
 */
export function projectDraftForConsumer(consumerPath, opts = {}) {
    const root = path.resolve(consumerPath);
    const id = opts.projectId || path.basename(root);
    const displayName = opts.displayName || id;
    const doc = defaultProjectDraft({ displayName, id });
    doc.agentRepo = { root };
    // `null` when the operator named no port: `buildProvisionPlan` claims one from the workspace, so
    // a draft never carries a number that could disagree with the registry.
    doc.observe = { port: normalizePort(opts.port) };
    doc.hostMode = opts.hostMode ?? 'dual-ide';
    if (opts.hostProfile) doc.hostProfile = opts.hostProfile;
    if (opts.plugins) doc.plugins = { ...defaultPlugins(), ...opts.plugins };
    return doc;
}

/**
 * Rewrite the host side of a consumer — and optionally its project anchor.
 *
 * Host side (always): hook bins, `hooks.json` (merged and de-duplicated), `sidecar.env`,
 * and `.harness/host-bootstrap.json` with a fresh `appliedAt`.
 *
 * `forceProject` additionally rewrites `harness.config.json` (and merges
 * `decision-policy.json`, re-writes `integrations.json`) — the repair path for an anchor
 * that `create-if-missing` would otherwise leave stale forever. `decision-policy.json` is
 * still only merged, never force-written: the plan's keys are re-applied, but operator
 * keys the plan does not define survive, whereas a forced rewrite would drop them.
 *
 * @param {object} project harness-console project JSON shape
 * @param {string} profilesDir ship unit profiles/
 * @param {{ registryPath?: string, forceProject?: boolean, verify?: boolean }} opts
 */
export function reloadHostConfig(project, profilesDir, opts = {}) {
    const forceProject = opts.forceProject === true;
    const plan = buildProvisionPlan(project, profilesDir, opts.registryPath || '', {
        force: forceProject,
        observePort: opts.observePort ?? project.observe?.port,
    });
    const files = forceProject ? writePlanFiles(plan) : [];
    const host = applyHostProfiles(plan.root, plan.hostProfiles, {
        observePort: plan.observePort,
        verify: opts.verify,
    });
    return {
        ok: true,
        root: plan.root,
        hostProfileIds: plan.hostProfileIds,
        projectRefreshed: forceProject,
        observePort: plan.observePort,
        observeUrl: `http://127.0.0.1:${plan.observePort}`,
        bootstrap: host.bootstrap,
        files: [...files, ...host.actions.map((a) => ({ relative: a.relative, action: a.action }))],
    };
}
