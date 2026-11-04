/**
 * @mu/eso-core — Team & Tool Configuration Management
 *
 * Covers:
 * - US-CFG-02 (ESO-330): Team group: install 7-role preset, protect custom roles,
 *   role deletion guard (ROLE_IN_USE), preset diff preview, 0-role project install,
 *   unassigned worker role warning.
 * - US-CFG-03 (ESO-335): Tool group: declare Jira/Notion/plan, unverified status,
 *   connection test & TOOL_UNREACHABLE marking, preserve pack source on provider switch,
 *   connection check idempotency (ED6), verbatim URL/key preservation (ED9).
 */

export const DEFAULT_7_ROLES = [
    { id: 'lead', name: 'Lead Architect', customized: false },
    { id: 'scout', name: 'Recon Worker', customized: false },
    { id: 'plan', name: 'Work Slicer', customized: false },
    { id: 'build', name: 'Scoped Peer Developer', customized: false },
    { id: 'verify', name: 'Deterministic Gate', customized: false },
    { id: 'audit', name: 'Independent Evaluator', customized: false },
    { id: 'qc', name: 'Scenario Executor', customized: false },
];

// ----------------------------------------------------
// US-CFG-02 / ESO-330: Team Group
// ----------------------------------------------------

export function applyTeamPreset({
    project,
    currentRoles = [],
    presetRoles = DEFAULT_7_ROLES,
    workers = [],
} = {}) {
    if (!project) throw new Error('Project is required');

    const skipped = [];
    const activeRoles = [...currentRoles];

    for (const pr of presetRoles) {
        const existing = activeRoles.find((r) => r.id === pr.id);
        if (existing) {
            if (existing.customized) {
                // AC-CFG-02-01: Customized role is not overwritten
                skipped.push(existing.id);
            }
        } else {
            // New role from preset added
            activeRoles.push({ ...pr });
        }
    }

    // AC-CFG-02-05 / ED10: Worker referencing deleted or missing role
    const activeRoleIds = new Set(activeRoles.map((r) => r.id));
    const missingRoles = [];

    for (const w of workers) {
        const workerRoleId = w.role_id || w.role_name || w.role;
        if (workerRoleId && !activeRoleIds.has(workerRoleId) && w.state !== 'retired') {
            if (!missingRoles.includes(workerRoleId)) {
                missingRoles.push(workerRoleId);
            }
        }
    }

    return {
        project,
        roles: activeRoles,
        skipped,
        missing_roles: missingRoles,
        applied_at: new Date().toISOString(),
    };
}

export function deleteTeamRole({
    project,
    roleId,
    roles = [],
    workers = [],
} = {}) {
    if (!roleId) throw new Error('Role ID is required');

    const targetRole = roles.find((r) => r.id === roleId || (r.name && r.name === roleId));
    const targetId = targetRole ? targetRole.id : roleId;
    const targetName = targetRole?.name || null;

    // AC-CFG-02-02: Role currently assigned to active workers cannot be deleted
    const assignedWorkers = workers.filter((w) => {
        const assigned = w.role_id || w.role_name || w.role;
        return (assigned === targetId || (targetName && assigned === targetName) || assigned === roleId) && w.state !== 'retired';
    });
    if (assignedWorkers.length > 0) {
        const err = new Error(
            `ROLE_IN_USE: Cannot delete role '${roleId}'. It is currently assigned to ${assignedWorkers.length} active worker(s)`
        );
        err.code = 'ROLE_IN_USE';
        err.role_id = roleId;
        err.assigned_workers = assignedWorkers.map((w) => w.worker_id || w.id || w.name);
        throw err;
    }

    const remainingRoles = roles.filter((r) => {
        if (targetId && r.id === targetId) return false;
        if (targetName && r.name === targetName) return false;
        return true;
    });

    return {
        success: true,
        project,
        deleted_role: roleId,
        roles: remainingRoles,
    };
}

export function diffTeamPreset({
    currentRoles = [],
    presetRoles = DEFAULT_7_ROLES,
} = {}) {
    // AC-CFG-02-03: Surfaces diff without applying changes
    const currentMap = new Map(currentRoles.map((r) => [r.id, r]));
    const presetMap = new Map(presetRoles.map((r) => [r.id, r]));

    const added = [];
    const modified = [];
    const customizedKept = [];

    for (const [id, pr] of presetMap.entries()) {
        if (!currentMap.has(id)) {
            added.push(pr);
        } else {
            const cur = currentMap.get(id);
            if (cur.customized) {
                customizedKept.push(cur);
            } else if (JSON.stringify(cur) !== JSON.stringify(pr)) {
                modified.push({ id, current: cur, preset: pr });
            }
        }
    }

    const removed = currentRoles.filter((r) => !presetMap.has(r.id));

    return {
        has_diff: added.length > 0 || modified.length > 0 || removed.length > 0,
        added,
        modified,
        removed,
        customized_kept: customizedKept,
        is_applied: false,
    };
}

// ----------------------------------------------------
// US-CFG-03 / ESO-335: Tool Group
// ----------------------------------------------------

export function declareToolConfig({
    project,
    toolId,
    toolConfig = {},
} = {}) {
    if (!project) throw new Error('Project is required');
    if (!toolId) throw new Error('Tool ID is required');

    // AC-CFG-03-01: Saved with status unverified
    // AC-CFG-03-05 / ED9: Project key and base URL preserved verbatim without normalization
    return {
        project,
        tool_id: toolId,
        config: { ...toolConfig },
        status: 'unverified',
        created_at: new Date().toISOString(),
    };
}

export function verifyToolConnection({
    project,
    toolId,
    toolConfig,
    testConnectionFn,
    existingConnections = [],
} = {}) {
    if (!toolId) throw new Error('Tool ID is required');

    const now = new Date().toISOString();
    let status = 'connected';
    let errorMessage = null;

    try {
        if (typeof testConnectionFn === 'function') {
            const ok = testConnectionFn();
            if (!ok) {
                status = 'TOOL_UNREACHABLE';
                errorMessage = 'Connection check failed';
            }
        }
    } catch (err) {
        // AC-CFG-03-02: Connection check fails (e.g. expired token) -> TOOL_UNREACHABLE
        status = 'TOOL_UNREACHABLE';
        errorMessage = err.message || 'TOOL_UNREACHABLE';
    }

    // AC-CFG-03-04 / ED6: Idempotent connection record (update in place, no duplicate)
    const existingIndex = existingConnections.findIndex((c) => c.tool_id === toolId && c.project === project);

    const record = {
        project,
        tool_id: toolId,
        status,
        error: errorMessage,
        last_checked_at: now,
        config: toolConfig,
    };

    const updatedConnections = [...existingConnections];
    if (existingIndex >= 0) {
        updatedConnections[existingIndex] = record;
    } else {
        updatedConnections.push(record);
    }

    return {
        record,
        all_connections: updatedConnections,
    };
}

export function switchToolSource({
    project,
    targetSource,
    existingPacks = [],
} = {}) {
    // AC-CFG-03-03: Switching provider does not mutate existing pack sources
    const preservedPacks = existingPacks.map((pack) => ({
        ...pack,
        // original source remains untouched
        source: pack.source,
    }));

    return {
        project,
        current_source: targetSource,
        packs: preservedPacks,
        switched_at: new Date().toISOString(),
    };
}
