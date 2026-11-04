/**
 * @mu/eso-iam — Worker Lifecycle & Orphan Work Routing (US-IAM-01 / ESO-176 / Slice S1)
 *
 * Implements:
 * - AC-IAM-01-01: Register worker with role and project; worker starts in active state holding exactly 1 role
 * - AC-IAM-01-02: Retiring active worker holding active work routes tasks to OPEN risks with owner + review_by
 * - AC-IAM-01-03: Registering worker with role not in catalog halts with UNKNOWN_ROLE (0 workers created)
 * - AC-IAM-01-04: ED1 — Team with 0 workers lists empty array without error
 * - AC-IAM-01-05: ED6 — Duplicate worker ID halts with DUPLICATE_ID (only 1 worker created)
 */

import crypto from 'node:crypto';

export function createWorker({
    project,
    worker_id,
    role,
    role_name,
    harness_source = 'eso-native',
    state = 'active',
    catalogRoles,
    existingWorkers = [],
} = {}) {
    if (!project) {
        const err = new Error('Project is required');
        err.code = 'INVALID_PROJECT';
        throw err;
    }

    const assignedRole = role || role_name;
    if (!assignedRole) {
        const err = new Error('Role is required');
        err.code = 'INVALID_ROLE';
        throw err;
    }

    const id = worker_id || crypto.randomUUID();

    // AC-IAM-01-05 / ED6: Duplicate check
    const duplicate = existingWorkers.find(
        (w) => w.project === project && w.worker_id === id
    );
    if (duplicate) {
        const err = new Error(`DUPLICATE_ID: Worker '${id}' already exists in project '${project}'`);
        err.code = 'DUPLICATE_ID';
        err.worker_id = id;
        throw err;
    }

    // AC-IAM-01-03: Check if role exists in catalog
    if (catalogRoles && Array.isArray(catalogRoles)) {
        const exists = catalogRoles.some((r) => {
            const name = typeof r === 'string' ? r : r.name;
            const status = typeof r === 'string' ? 'current' : r.status || 'current';
            const matchesRole = name === assignedRole;
            const validStatus = status === 'current' || status === 'superseded';
            const matchesProject = !r.project || r.project === project;
            return matchesRole && validStatus && matchesProject;
        });

        if (!exists) {
            const err = new Error(`UNKNOWN_ROLE: Role '${assignedRole}' does not exist in catalog for project '${project}'`);
            err.code = 'UNKNOWN_ROLE';
            err.role = assignedRole;
            throw err;
        }
    }

    return {
        project,
        worker_id: id,
        role_name: assignedRole,
        harness_source,
        state,
    };
}

export function retireWorker({
    worker,
    activeWork = [],
    reviewer = 'operator',
} = {}) {
    if (!worker || typeof worker !== 'object') {
        const err = new Error('Worker object is required');
        err.code = 'INVALID_WORKER';
        throw err;
    }

    // AC-IAM-01-02: Convert unfinished work into OPEN risk entries
    const open_risks = (Array.isArray(activeWork) ? activeWork : []).map((work, idx) => ({
        risk_id: work.risk_id || `risk-retire-${worker.worker_id}-${idx + 1}`,
        project: worker.project,
        kind: 'orphaned_work',
        status: 'OPEN',
        owner: work.new_owner || work.owner || null,
        review_by: reviewer,
        what: work.what || work.title || `Việc đang dở từ worker ${worker.worker_id}`,
        task_id: work.task_id || work.id || null,
        created_at: new Date().toISOString(),
    }));

    return {
        ...worker,
        state: 'retired',
        open_risks,
    };
}

export function listWorkers({
    workers = [],
    project,
} = {}) {
    if (!Array.isArray(workers)) {
        return [];
    }
    if (!project) {
        return workers;
    }
    return workers.filter((w) => w.project === project);
}
