import { createHash } from 'node:crypto';

/**
 * @mu/eso-control-plane — Configuration Change & Attribute Management
 * Covers:
 * - US-IAM-06 (ESO-295): Preview impact, single-action save, one-action revert, tenant isolation
 * - US-IAM-09 (ESO-325): Attribute impact preview, RBAC, optimistic locking, rename migration
 */

function computeHash(data) {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

// ==========================================
// US-IAM-06 / ESO-295: Configuration Manager
// ==========================================

export function previewConfigChange({
    project,
    currentConfig = { version: 1 },
    pendingChange,
    projectsList = [],
    artefacts = [],
}: any = {}) {
    if (!project || typeof project !== 'string') {
        throw new Error('Project is required');
    }
    if (!pendingChange || typeof pendingChange !== 'object') {
        throw new Error('Pending change is required');
    }

    const baseVersion = currentConfig.version || 1;
    const previewHash = computeHash({ project, baseVersion, pendingChange });

    // Identify users, overrides, and affected artefacts
    const users = pendingChange.users || (currentConfig.roles ? Object.keys(currentConfig.roles) : []);
    const overrides = pendingChange.overrides || (currentConfig.custom_overrides || []);
    const affected_artefacts = artefacts.filter((a) => a.project === project).map((a) => a.id);

    // AC-IAM-06-06 / ED3: Shared preset across multiple projects (e.g. 50 projects)
    const impact = [];
    if (pendingChange.preset_id) {
        const sharedProjects = projectsList.filter((p) => p.preset_id === pendingChange.preset_id);
        for (const sp of sharedProjects) {
            impact.push({
                project: sp.id,
                preset_id: pendingChange.preset_id,
                action: 'upgrade',
            });
        }
    }

    return {
        project,
        base_version: baseVersion,
        preview_hash: previewHash,
        users,
        overrides,
        affected_artefacts,
        impact,
    };
}

export function saveConfigChange({
    project,
    currentConfig = { version: 1 },
    pendingChange,
    previewHash,
    operator = 'operator',
}: any = {}) {
    if (!project || typeof project !== 'string') {
        throw new Error('Project is required');
    }

    // AC-IAM-06-04 / tenant: Verify project isolation
    if (currentConfig.project && currentConfig.project !== project) {
        const err: any = new Error(`TENANT_VIOLATION: Cannot modify configuration for '${currentConfig.project}' from tenant '${project}'`);
        err.code = 'TENANT_VIOLATION';
        throw err;
    }

    // AC-IAM-06-02 & AC-IAM-06-05 / ED4: Exact preview hash check
    const expectedHash = computeHash({ project, baseVersion: currentConfig.version || 1, pendingChange });
    if (!previewHash || previewHash !== expectedHash) {
        const err: any = new Error('PREVIEW_HASH_MISMATCH: Configuration changes must be previewed prior to save; preview hash does not match');
        err.code = 'PREVIEW_HASH_MISMATCH';
        err.expected_hash = expectedHash;
        err.provided_hash = previewHash;
        throw err;
    }

    const newVersion = (currentConfig.version || 1) + 1;
    const savedAt = new Date().toISOString();

    const savedRecord = {
        ...currentConfig,
        ...pendingChange,
        project,
        version: newVersion,
        last_modified_by: operator,
        last_modified_at: savedAt,
    };

    const historyRecord = {
        version: newVersion,
        previous_version: currentConfig.version || 1,
        saved_at: savedAt,
        operator,
        snapshot: currentConfig,
    };

    return {
        config: savedRecord,
        history: historyRecord,
    };
}

export function revertConfigChange({
    project,
    currentConfig,
    history = [],
    artefacts = [],
    operator = 'operator',
}: any = {}) {
    if (!history || history.length === 0) {
        const err: any = new Error('NO_HISTORY_TO_REVERT: No previous configuration version available');
        err.code = 'NO_HISTORY_TO_REVERT';
        throw err;
    }

    const lastEntry = history[history.length - 1];
    const revertTime = new Date().toISOString();

    // AC-IAM-06-03: Mark artefacts created between [saved_at, revertTime]
    const markedArtefacts = artefacts.map((art) => {
        if (art.project === project && art.created_at >= lastEntry.saved_at) {
            return {
                ...art,
                marked_reverted: true,
                invalidation_reason: 'CONFIG_REVERTED',
                reverted_at: revertTime,
            };
        }
        return art;
    });

    return {
        config: {
            ...lastEntry.snapshot,
            version: lastEntry.previous_version,
            reverted_at: revertTime,
            reverted_by: operator,
        },
        marked_artefacts: markedArtefacts,
    };
}

// ==========================================
// US-IAM-09 / ESO-325: Attributes Manager
// ==========================================

export function previewAttributeChange({
    project,
    attributeKey,
    action, // 'update' | 'delete' | 'rename'
    newValue,
    policies = [],
    currentVersion = 1,
}: any = {}) {
    const affectedPolicies = policies.filter((p) => {
        if (p.attribute === attributeKey) return true;
        if (p.target_attribute === attributeKey) return true;
        if (Array.isArray(p.attributes) && p.attributes.includes(attributeKey)) return true;
        if (Array.isArray(p.attributes_used)) return p.attributes_used.includes(attributeKey);
        if (Array.isArray(p.uses)) return p.uses.includes(attributeKey);
        return false;
    });

    const previewHash = computeHash({ project, attributeKey, action, newValue, currentVersion });

    return {
        project,
        attribute_key: attributeKey,
        action,
        new_value: newValue,
        version: currentVersion,
        preview_hash: previewHash,
        affected_policies: affectedPolicies.map((p) => p.id || p.name),
        affected_count: affectedPolicies.length,
    };
}

export function saveAttributeChange({
    project,
    attributeKey,
    action,
    newValue,
    policies = [],
    currentVersion = 1,
    requestedVersion = 1,
    actorRole = 'operator',
    hasMigrationPlan = false,
}: any = {}) {
    // AC-IAM-09-02 / rbac: Only operator/human can mutate policies/attributes
    if (actorRole !== 'operator' && actorRole !== 'admin') {
        const err: any = new Error(`FORBIDDEN_MUTATION: Actor with role '${actorRole}' is prohibited from modifying policy attributes`);
        err.code = 'FORBIDDEN_MUTATION';
        err.role = actorRole;
        throw err;
    }

    // AC-IAM-09-04 / ED7: Optimistic concurrency control
    if (requestedVersion !== currentVersion) {
        const err: any = new Error(`STALE_VERSION: Attribute version mismatch. Expected ${currentVersion}, got ${requestedVersion}`);
        err.code = 'STALE_VERSION';
        err.current_version = currentVersion;
        err.requested_version = requestedVersion;
        throw err;
    }

    const inUsePolicies = policies.filter((p) => {
        if (p.attribute === attributeKey) return true;
        if (p.target_attribute === attributeKey) return true;
        if (Array.isArray(p.attributes) && p.attributes.includes(attributeKey)) return true;
        if (Array.isArray(p.attributes_used)) return p.attributes_used.includes(attributeKey);
        if (Array.isArray(p.uses)) return p.uses.includes(attributeKey);
        return false;
    });

    // AC-IAM-09-03: Deleting attribute currently in use
    if (action === 'delete' && inUsePolicies.length > 0) {
        const err: any = new Error(
            `ATTRIBUTE_IN_USE: Cannot delete attribute '${attributeKey}' used by ${inUsePolicies.length} policy/policies`
        );
        err.code = 'ATTRIBUTE_IN_USE';
        err.attribute_key = attributeKey;
        err.used_by = inUsePolicies.map((p) => p.id || p.name);
        throw err;
    }

    // AC-IAM-09-05 / ED10: Renaming attribute currently in use without migration plan
    if (action === 'rename' && inUsePolicies.length > 0 && !hasMigrationPlan) {
        const err: any = new Error(
            `RENAME_WITHOUT_MIGRATION: Cannot rename attribute '${attributeKey}' without an explicit migration plan`
        );
        err.code = 'RENAME_WITHOUT_MIGRATION';
        err.attribute_key = attributeKey;
        throw err;
    }

    return {
        success: true,
        project,
        attribute_key: action === 'rename' ? newValue : attributeKey,
        action,
        version: currentVersion + 1,
        saved_at: new Date().toISOString(),
    };
}
