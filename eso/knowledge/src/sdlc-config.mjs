import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @mu/eso-knowledge — SDLC & Four-Group Unified Configuration
 *
 * Covers:
 * - US-CFG-01 (ESO-201): Unified 4-group config (sdlc, team, tools, project), atomic save,
 *   sdlc_root migration guard, preserve customized roles, RBAC, no-op zero change, hash check.
 * - US-SDLC-01 (ESO-206): SDLC project initialization (init, check, upgrade), idempotency,
 *   missing config guard, applies_when filtering, tenant isolation, multi-project upgrade,
 *   dangling root detection.
 */

function hashData(obj) {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// ----------------------------------------------------
// US-CFG-01 / ESO-201: Unified 4-Group Page Configuration
// ----------------------------------------------------

export function previewPageConfiguration({
    project,
    currentConfig = { version: 1, groups: {} },
    pendingChanges = {},
} = {}) {
    if (!project) throw new Error('Project is required');
    const baseVersion = currentConfig.version || 1;
    const previewHash = hashData({ project, baseVersion, pendingChanges });

    return {
        project,
        base_version: baseVersion,
        preview_hash: previewHash,
        changes: pendingChanges,
    };
}

export function savePageConfiguration({
    project,
    currentConfig = {
        version: 1,
        groups: {
            sdlc: { sdlc_root: 'sdlc' },
            team: { roles: [] },
            tools: { jira: null },
            project: { name: project },
        },
    },
    pendingChanges = {},
    previewHash,
    actorRole = 'operator',
    existingArtefacts = [],
    migrationPlan = null,
} = {}) {
    if (!project) throw new Error('Project is required');

    // AC-CFG-01-04 / RBAC: Non-operator/admin role is prohibited
    if (actorRole !== 'operator' && actorRole !== 'admin') {
        const err = new Error(`FORBIDDEN_MUTATION: Agent role '${actorRole}' is prohibited from saving page configuration`);
        err.code = 'FORBIDDEN_MUTATION';
        err.role = actorRole;
        throw err;
    }

    // AC-CFG-01-05 / ED1: 0 changes on all 4 groups -> no-op
    const changeKeys = Object.keys(pendingChanges);
    if (changeKeys.length === 0) {
        return {
            unchanged: true,
            version: currentConfig.version || 1,
            message: 'không đổi: 0 thay đổi trên cả bốn nhóm',
            groups: currentConfig.groups,
        };
    }

    // AC-CFG-01-06 / ED4: Preview hash check
    const expectedHash = hashData({
        project,
        baseVersion: currentConfig.version || 1,
        pendingChanges,
    });
    if (!previewHash || previewHash !== expectedHash) {
        const err = new Error('PREVIEW_HASH_MISMATCH: Configuration changes must match previewed hash');
        err.code = 'PREVIEW_HASH_MISMATCH';
        throw err;
    }

    const currentGroups = currentConfig.groups || {};
    const newGroups = {
        sdlc: { ...(currentGroups.sdlc || {}), ...(pendingChanges.sdlc || {}) },
        team: { ...(currentGroups.team || {}), ...(pendingChanges.team || {}) },
        tools: { ...(currentGroups.tools || {}), ...(pendingChanges.tools || {}) },
        project: { ...(currentGroups.project || {}), ...(pendingChanges.project || {}) },
    };

    // AC-CFG-01-02: Changed sdlc_root while documents exist under old sdlc_root without migration plan
    const oldRoot = currentGroups.sdlc && currentGroups.sdlc.sdlc_root;
    const newRoot = newGroups.sdlc && newGroups.sdlc.sdlc_root;
    if (oldRoot && newRoot && oldRoot !== newRoot) {
        const docsUnderOldRoot = existingArtefacts.filter((a) => a.project === project && a.path && a.path.startsWith(oldRoot));
        if (docsUnderOldRoot.length > 0 && !migrationPlan) {
            const err = new Error(
                `MIGRATION_PLAN_REQUIRED: Cannot change sdlc_root from '${oldRoot}' to '${newRoot}'. Existing documents detected under old root without migration plan.`
            );
            err.code = 'MIGRATION_PLAN_REQUIRED';
            err.affected_paths = docsUnderOldRoot.map((d) => d.path);
            throw err;
        }
    }

    // AC-CFG-01-03 / AC-CFG-02-01: Preset roles installation skips customized roles
    let skippedRoles = [];
    if (pendingChanges.team && pendingChanges.team.apply_preset_roles) {
        const existingRoles = (currentGroups.team && currentGroups.team.roles) || [];
        const presetRoles = pendingChanges.team.apply_preset_roles;
        const finalRoles = [...existingRoles];

        for (const pr of presetRoles) {
            const existing = existingRoles.find((r) => r.id === pr.id);
            if (existing && existing.customized) {
                skippedRoles.push(existing.id);
            } else if (!existing) {
                finalRoles.push(pr);
            }
        }
        newGroups.team.roles = finalRoles;
        delete newGroups.team.apply_preset_roles;
    }

    const newVersion = (currentConfig.version || 1) + 1;

    // AC-CFG-01-01: Atomic save across 4 groups
    return {
        unchanged: false,
        version: newVersion,
        project,
        groups: newGroups,
        skipped_roles: skippedRoles,
        saved_at: new Date().toISOString(),
        saved_by: actorRole,
    };
}

// ----------------------------------------------------
// US-SDLC-01 / ESO-206: SDLC Project Initialization
// ----------------------------------------------------

export function initProjectSdlc({
    project,
    config = {},
    appliesWhen = {},
    existingArtefacts = [],
    isReInit = false,
    consumerPath = null,
} = {}) {
    if (!project) throw new Error('Project is required');

    // AC-SDLC-01-02: Missing required declaration (e.g. sdlc_root)
    if (!config.sdlc_root || typeof config.sdlc_root !== 'string' || config.sdlc_root.trim() === '') {
        const err = new Error("MISSING_CONFIG: Project initialization rejected. Missing required declaration 'sdlc_root'");
        err.code = 'MISSING_CONFIG';
        err.missing_fields = ['sdlc_root'];
        err.files_created = [];
        throw err;
    }

    // AC-SDLC-01-07 / ED10: Changed sdlc_root while artefacts still point to old root
    const oldRootArtefact = existingArtefacts.find(
        (a) => a.project === project && a.root && a.root !== config.sdlc_root
    );
    if (oldRootArtefact) {
        const err = new Error(
            `DANGLING_ARTEFACTS_ROOT: Cannot init second SDLC root '${config.sdlc_root}'. Artefacts already exist under root '${oldRootArtefact.root}'.`
        );
        err.code = 'DANGLING_ARTEFACTS_ROOT';
        err.existing_root = oldRootArtefact.root;
        throw err;
    }

    // AC-SDLC-01-01: Idempotency check on re-run (flag or disk check)
    if (isReInit) {
        return {
            changed: false,
            project,
            sdlc_root: config.sdlc_root,
            files_created: [],
            existing: [],
            message: 'Idempotent re-run: 0 changes',
        };
    }

    // Standard profile templates
    const allTemplates = [
        { path: `${config.sdlc_root}/01.architecture.md`, tag: 'common' },
        { path: `${config.sdlc_root}/02.backend-spec.md`, tag: 'backend' },
        { path: `${config.sdlc_root}/03.frontend-spec.md`, tag: 'frontend' },
        { path: `${config.sdlc_root}/04.jira-integration.md`, tag: 'jira' },
    ];

    const targetTemplates = [];
    const outScope = [];

    // AC-SDLC-01-03: Filter by applies_when conditions
    for (const t of allTemplates) {
        if (t.tag === 'frontend' && appliesWhen.has_fe === false) {
            outScope.push({ template: t.path, reason: 'project has no frontend (has_fe=false)' });
            continue;
        }
        if (t.tag === 'jira' && appliesWhen.has_jira === false) {
            outScope.push({ template: t.path, reason: 'project has no Jira integration (has_jira=false)' });
            continue;
        }
        targetTemplates.push(t.path);
    }

    // Disk-based idempotency check when consumerPath is provided
    if (consumerPath) {
        const existingOnDisk = targetTemplates.filter((rel) => fs.existsSync(path.join(consumerPath, rel)));
        if (existingOnDisk.length === targetTemplates.length) {
            return {
                changed: false,
                project,
                sdlc_root: config.sdlc_root,
                files_created: [],
                existing: existingOnDisk,
                out_scope: outScope,
                message: 'Idempotent re-run: 0 changes',
            };
        }
    }

    // Write real files to disk when consumerPath is provided (DoD B10 / ESO-388).
    // Without a consumer root there is nowhere to write, so report no files: the old
    // `else` branch listed every template as created while the disk stayed untouched.
    const generatedFiles = [];
    if (consumerPath) {
        for (const rel of targetTemplates) {
            const fullPath = path.join(consumerPath, rel);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            if (!fs.existsSync(fullPath)) {
                fs.writeFileSync(fullPath, `# ${path.basename(rel)}\n\nAuto-generated SDLC template for ${project}\n`, 'utf8');
                generatedFiles.push(rel);
            }
        }
    }

    // AC-SDLC-01-06 / ED1: Blank project with 0 existing folders inits full tree
    return {
        changed: generatedFiles.length > 0,
        project,
        sdlc_root: config.sdlc_root,
        files_created: generatedFiles,
        out_scope: outScope,
        initialized_at: new Date().toISOString(),
    };
}

export function upgradeProjectSdlcStandard({
    projects = [],
    targetStandardVersion = '2.0.0',
    dryRun = false,
    consumerPath = null,
} = {}) {
    const upgradeId = `upg_${randomUUID()}`;
    const snapshot = projects.map((p) => {
        const projDir = p.path || (consumerPath ? (projects.length === 1 && !p.path ? consumerPath : path.join(consumerPath, p.id || p.project)) : null);
        let previousContent = null;
        let versionFile = null;
        if (projDir && fs.existsSync(projDir)) {
            versionFile = path.join(projDir, '.sdlc-standard.json');
            if (fs.existsSync(versionFile)) {
                previousContent = fs.readFileSync(versionFile, 'utf8');
            }
        }
        return {
            id: p.id || p.project,
            previous_version: p.standard_version || '1.0.0',
            projDir,
            versionFile,
            previousContent,
        };
    });

    if (!dryRun) {
        for (const s of snapshot) {
            if (s.projDir && fs.existsSync(s.projDir)) {
                const targetFile = s.versionFile || path.join(s.projDir, '.sdlc-standard.json');
                fs.writeFileSync(
                    targetFile,
                    JSON.stringify({ standard_version: targetStandardVersion, updated_at: new Date().toISOString() }, null, 2),
                    'utf8'
                );
            }
        }
    }

    // AC-SDLC-01-05: Multi-project upgrade across >=2 projects
    const impact = projects.map((p) => ({
        project: p.id || p.project,
        current_version: p.standard_version || '1.0.0',
        target_version: targetStandardVersion,
        action: 'upgrade_sdlc_templates',
    }));

    return {
        success: true,
        upgrade_id: upgradeId,
        upgraded_count: projects.length,
        impact,
        can_revert: true,
        revert_snapshot: snapshot,
        target_standard_version: targetStandardVersion,
    };
}

export function revertProjectSdlcStandard({
    upgradeResult,
    snapshot,
} = {}) {
    const records = snapshot || upgradeResult?.revert_snapshot || [];
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error('Valid revert snapshot is required to revert standard upgrade');
    }

    for (const r of records) {
        if (r.projDir && r.versionFile) {
            if (r.previousContent !== null) {
                fs.writeFileSync(r.versionFile, r.previousContent, 'utf8');
            } else if (fs.existsSync(r.versionFile)) {
                fs.unlinkSync(r.versionFile);
            }
        }
    }

    const reverted = records.map((r) => ({
        project: r.id || r.project,
        restored_version: r.previous_version,
        action: 'revert_sdlc_templates',
    }));

    return {
        success: true,
        reverted_count: reverted.length,
        impact: reverted,
    };
}
