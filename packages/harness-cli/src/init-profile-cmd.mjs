import fs from 'node:fs';
import path from 'node:path';
import { initProfile, projectDraftForConsumer } from '@mu/harness-foundation/init-profile';
import {
    buildOwnershipReport,
    classifyPolicyOwnership,
    ownershipVerdict,
    renderOwnershipReport,
} from '@mu/harness-foundation/ownership-report';
import { checkGuardFreshness } from '@mu/harness-eso-core';
import { buildProvisionPlan, loadProject, saveProject } from '@mu/harness-foundation/project-registry';
import {
    ensureProductState,
    productStateDir,
    syncProjectsFromWorkspace,
    registryFile,
    loadWorkspace,
    saveWorkspace,
} from '@mu/harness-foundation/workspace';
import { assignObservePort, normalizePort } from '@mu/harness-foundation/observe-port';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';

function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.join(ESO_ROOT, 'profiles');
}

/**
 * @param {string[]} argv after `init profile`
 */
export function runInitProfile(argv) {
    applyWorkspaceEnv();
    ensureProductState();

    const positional = [];
    const opts = {
        // No default port. A missing `--port` means "claim one from the workspace"; writing 8792 here
        // is what made every fresh consumer point at the first project's stack.
        port: null,
        hostMode: 'dual-ide',
        dryRun: false,
        force: false,
        projectId: null,
        displayName: null,
        hostProfile: null,
        fromConsoleProject: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--plan') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--id') opts.projectId = argv[++i];
        else if (a === '--name') opts.displayName = argv[++i];
        else if (a === '--port') opts.port = Number.parseInt(argv[++i], 10);
        else if (a === '--host-mode') opts.hostMode = argv[++i];
        else if (a === '--host-profile') opts.hostProfile = argv[++i];
        else if (a === '--project') opts.fromConsoleProject = argv[++i];
        else if (a.startsWith('-')) {
            throw new Error(`unknown flag: ${a}`);
        } else positional.push(a);
    }

    if (positional.length !== 1) {
        throw new Error('usage: init profile <consumer-path> [--plan] [--force] [--id <id>] [--name <name>] [--host-mode dual-ide|all-ide|claude|superset] [--project <console-project-id>]');
    }

    const consumerPath = path.resolve(positional[0]);
    const workspace = loadWorkspace();
    let project;
    if (opts.fromConsoleProject) {
        project = loadProject(productStateDir(), opts.fromConsoleProject);
        if (!project) throw new Error(`console project not found: ${opts.fromConsoleProject}`);
        project.agentRepo = { ...project.agentRepo, root: consumerPath };
    } else {
        project = projectDraftForConsumer(consumerPath, opts);
    }

    /*
     * The port is claimed before provisioning and written to **both** registries. The document used to
     * keep its own `observe.port` while the workspace kept another, and `initProfile` read whichever
     * one it was handed — so `harness.config.json`, `sidecar.env` and `host-bootstrap.json` could name
     * a number the registry never agreed to.
     */
    const port = assignObservePort(workspace, project.id, {
        preferred: normalizePort(opts.port),
    });
    project.observe = { ...(project.observe || {}), port };
    /*
     * Read the policy **before** `initProfile` writes it. `writePlanFiles` merges the plan over the
     * prior document, so this is the only moment the operator's value still exists to be reported.
     * Silence here was the defect: `status: merged` looked identical whether the merge changed a key
     * or not, so a tuned `eso.enforceWrites: off` was replaced with no trace in the output.
     */
    const overwritten = buildProvisionPlan(project, profilesDir(), registryFile(), { observePort: port });
    const overwrittenKeys = policyOverwrites(overwritten);

    const result = initProfile(project, profilesDir(), registryFile(), {
        dryRun: opts.dryRun,
        force: opts.force,
        observePort: port,
    });
    result.policyOverwrites = overwrittenKeys;
    if (!opts.dryRun) {
        const row = {
            id: project.id,
            displayName: project.displayName,
            root: result.root,
            rootHost: result.root,
            port,
            profile: 'generic-eso',
            initProfile: true,
        };
        const idx = workspace.projects.findIndex((p) => p.id === project.id);
        if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
        else workspace.projects.push(row);
        workspace.defaultProjectId = workspace.defaultProjectId || project.id;
        saveWorkspace(workspace);
        syncProjectsFromWorkspace(workspace);

        project.status = 'provisioned';
        project.provisionedAt = new Date().toISOString();
        saveProject(productStateDir(), project);
    }

    return result;
}

/**
 * `harnessctl init report <consumer>` — which policy keys are the product's, which are the consumer's,
 * and which the next provision will overwrite.
 *
 * It reuses `runInitProfile`'s plan path (`--plan` is the same dry run, so the two cannot disagree),
 * then classifies the file against that plan. The guard-freshness half is read from the same module H1
 * uses, so "stale guard" here and "H1 fails" in `verify host` are one fact, not two.
 */
export function runInitReport(argv) {
    applyWorkspaceEnv();
    ensureProductState();
    const { reportArgs, initArgs } = splitReportArgs(argv);
    if (reportArgs.json) {
        const result = runInitProfile([...initArgs, '--plan']);
        const report = buildOwnershipReport(result.root, planFor(result));
        console.log(
            JSON.stringify(
                { ...report, planned: plannedPolicy(result), guards: checkGuardFreshness(result.root), verdict: ownershipVerdict(report) },
                null,
                2,
            ),
        );
        return;
    }
    const result = runInitProfile([...initArgs, '--plan']);
    const report = buildOwnershipReport(result.root, planFor(result));
    console.log(renderOwnershipReport(report, { guardFreshness: checkGuardFreshness(result.root) }));
    if (report.policy.state === 'unreadable') process.exitCode = 1;
}

function plannedPolicy(dryRunResult) {
    const f = dryRunResult.files.find((x) => x.relative === POLICY_RELATIVE);
    return f ? f.preview : null;
}

/** Kept here so the two commands name the same file; `init-profile.mjs` owns the writer, not the name. */
const POLICY_RELATIVE = '.harness/decision-policy.json';

function splitReportArgs(argv) {
    const reportArgs = { json: false };
    const initArgs = [];
    for (const a of argv) {
        if (a === '--json') reportArgs.json = true;
        else initArgs.push(a);
    }
    return { reportArgs, initArgs };
}

/**
 * `init profile --plan` returns the sanitized file list, not the plan object (it drops `path` and keeps
 * `preview`). That is enough to classify ownership — and deliberately so: the report must not need a
 * second, differently-shaped planner.
 */
function planFor(dryRunResult) {
    return { files: dryRunResult.files };
}

/**
 * One line per key the next `init profile` will change — the "silent merge" half of the ownership gap.
 *
 * `writePlanFiles` reports `status: merged` for the policy file whichever way the merge went, so an
 * operator who tuned `eso.enforceWrites` saw the same word as one who tuned nothing. This prints the
 * actual transitions at the moment they happen. It is computed from what is on disk **before** the
 * write, which is why `runInitProfile` calls it first.
 */
function policyOverwrites(plan) {
    try {
        const policy = plan.files.find((f) => f.relative === POLICY_RELATIVE);
        if (!policy) return [];
        const file = path.join(plan.root, POLICY_RELATIVE);
        if (!fs.existsSync(file)) return [];
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        return classifyPolicyOwnership(current, policy.preview).overridden;
    } catch {
        // A report must never fail the provision it describes. An unreadable policy is already
        // reported by `init report` as `unreadable`; provisioning still has to run.
        return [];
    }
}
