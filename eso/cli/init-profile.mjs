import fs from 'node:fs';
import path from 'node:path';

/**
 * Validate that target path is strictly inside consumerRoot (Never write outside consumer directory).
 */
export function assertWithinConsumer(consumerRoot, targetPath) {
    const resolvedRoot = path.resolve(consumerRoot);
    const resolvedTarget = path.resolve(targetPath);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
        const err = new Error(`ACCESS_DENIED: Target path "${resolvedTarget}" is outside consumer directory "${resolvedRoot}"`);
        err.code = 'OUTSIDE_CONSUMER';
        throw err;
    }
}

/**
 * Generate default configuration object for ESO v2 consumer.
 */
export function defaultEsoV2Config(projectId) {
    return {
        version: 1,
        project: projectId,
        id: projectId,
        eso: {
            version: '2.0.0',
            mode: 'observe',
        },
        created_at: new Date().toISOString(),
    };
}

/**
 * Generate default state object for ESO v2 consumer.
 */
export function defaultEsoV2State(projectId) {
    return {
        version: 1,
        status: 'initialized',
        project: projectId,
        initialized_at: new Date().toISOString(),
        last_run: null,
    };
}

/**
 * Build file plan for ESO v2 init profile.
 */
export function buildProfilePlan(consumerPath, { projectId = null } = {}) {
    const root = path.resolve(consumerPath);
    const id = projectId || path.basename(root);

    const configPath = path.join(root, '.harness', 'config.json');
    const statePath = path.join(root, '.harness', 'state.json');

    assertWithinConsumer(root, configPath);
    assertWithinConsumer(root, statePath);

    return {
        root,
        projectId: id,
        files: [
            {
                relative: '.harness/config.json',
                path: configPath,
                content: JSON.stringify(defaultEsoV2Config(id), null, 2) + '\n',
                action: 'create',
            },
            {
                relative: '.harness/state.json',
                path: statePath,
                content: JSON.stringify(defaultEsoV2State(id), null, 2) + '\n',
                action: 'create',
            },
        ],
    };
}

/**
 * Perform init profile for ESO v2.
 *
 * Requirements:
 * - If `--dry-run` or `--plan` is passed: write 0 files to disk, report dry run file list.
 * - 2 repeated runs must report `changed: false` on the second run (idempotent).
 * - Never write outside the consumer directory.
 */
export function initProfileV2(consumerPath, opts = {}) {
    const dryRun = opts.dryRun === true || opts.plan === true;
    const force = opts.force === true;
    const plan = buildProfilePlan(consumerPath, opts);

    const filesReport = [];
    let anyChanged = false;

    for (const f of plan.files) {
        assertWithinConsumer(plan.root, f.path);
        const exists = fs.existsSync(f.path);
        let existingContent = null;
        if (exists) {
            existingContent = fs.readFileSync(f.path, 'utf8');
        }

        let willWrite = !exists || force;
        if (exists && !force) {
            try {
                const prior = JSON.parse(existingContent);
                const planned = JSON.parse(f.content);
                const isSemanticallyEqual = (f.relative === '.harness/config.json')
                    ? (prior.version === planned.version && prior.project === planned.project && JSON.stringify(prior.eso) === JSON.stringify(planned.eso))
                    : (f.relative === '.harness/state.json')
                        ? (prior.version === planned.version && prior.status === planned.status && prior.project === planned.project)
                        : (existingContent === f.content);
                if (isSemanticallyEqual) {
                    willWrite = false;
                }
            } catch {
                willWrite = true;
            }
        }

        if (willWrite) {
            anyChanged = true;
        }

        filesReport.push({
            relative: f.relative,
            path: f.path,
            action: willWrite ? (exists ? 'update' : 'create') : 'unchanged',
            exists,
            changed: willWrite,
        });

        if (!dryRun && willWrite) {
            fs.mkdirSync(path.dirname(f.path), { recursive: true });
            fs.writeFileSync(f.path, f.content, 'utf8');
        }
    }

    return {
        ok: true,
        dryRun,
        changed: anyChanged,
        root: plan.root,
        projectId: plan.projectId,
        files: filesReport,
    };
}
