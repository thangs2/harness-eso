/**
 * @mu/eso-control-plane — Flow & Handover Management (US-IAM-04 / ESO-191)
 *
 * Implements:
 * - AC-IAM-04-01: Flow A->B declared, A brings evidence superset of bar(B) -> Handover allowed
 * - AC-IAM-04-02: A missing required item in bar(B) -> Blocked with HANDOFF_INCOMPLETE and missing items
 * - AC-IAM-04-03: bar(B) empty -> Handover allowed with unconstrained: true recorded
 * - AC-IAM-04-04: Flow with 0 steps -> Rejected with EMPTY_FLOW
 * - AC-IAM-04-05: Duplicate flow ID in same project -> Rejected with DUPLICATE_ID
 * - AC-IAM-04-06: Flow introduces a cycle A->B->A -> Rejected with FLOW_CYCLE
 * - AC-IAM-07-03: Retired worker present in flow -> Reads flow with warning requiring edit or OPEN risk
 */

import { BASIS_RANK } from '../../../../../iam/src/schema.mjs';

export function validateAndCreateFlow({
    id,
    project,
    name,
    steps = [],
    from,
    to,
    carries = [],
    existingFlows = [],
}: any = {}) {
    if (!id || typeof id !== 'string') {
        const err: any = new Error('Flow ID is required');
        err.code = 'INVALID_FLOW_ID';
        throw err;
    }
    if (!project || typeof project !== 'string') {
        const err: any = new Error('Project is required');
        err.code = 'INVALID_PROJECT';
        throw err;
    }

    // AC-IAM-04-05 / ED6: Duplicate ID in same project
    if (existingFlows.some((f) => f.id === id && f.project === project)) {
        const err: any = new Error(`DUPLICATE_ID: Flow with id '${id}' already exists in project '${project}'`);
        err.code = 'DUPLICATE_ID';
        err.flow_id = id;
        throw err;
    }

    // Normalizing steps from steps array or direct from/to pair
    let flowSteps = Array.isArray(steps) ? [...steps] : [];
    if (flowSteps.length === 0 && from && to) {
        flowSteps.push({ from, to, carries });
    }

    // AC-IAM-04-04 / ED1: 0 steps
    if (flowSteps.length === 0) {
        const err: any = new Error('EMPTY_FLOW: Flow must contain at least 1 step');
        err.code = 'EMPTY_FLOW';
        throw err;
    }

    // AC-IAM-04-06: Cycle detection
    const adj = new Map();
    for (const step of flowSteps) {
        if (!step.from || !step.to) {
            const err: any = new Error('Each step must specify from and to');
            err.code = 'INVALID_STEP';
            throw err;
        }
        if (step.from === step.to) {
            const err: any = new Error(`FLOW_CYCLE: Direct self-cycle detected from '${step.from}' to '${step.to}'`);
            err.code = 'FLOW_CYCLE';
            throw err;
        }
        if (!adj.has(step.from)) adj.set(step.from, []);
        adj.get(step.from).push(step.to);
    }

    // Check existing flows in same project to ensure compound cycles aren't created
    for (const ef of existingFlows.filter((f) => f.project === project)) {
        for (const s of ef.steps || []) {
            if (!adj.has(s.from)) adj.set(s.from, []);
            adj.get(s.from).push(s.to);
        }
    }

    // Cycle check via DFS
    const visited = new Set();
    const inStack = new Set();

    function hasCycle(node) {
        visited.add(node);
        inStack.add(node);

        const neighbors = adj.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                if (hasCycle(neighbor)) return true;
            } else if (inStack.has(neighbor)) {
                return true;
            }
        }

        inStack.delete(node);
        return false;
    }

    for (const node of adj.keys()) {
        if (!visited.has(node)) {
            if (hasCycle(node)) {
                const err: any = new Error('FLOW_CYCLE: Flow creation introduces a cyclic dependency');
                err.code = 'FLOW_CYCLE';
                throw err;
            }
        }
    }

    return {
        id,
        project,
        name: name || id,
        steps: flowSteps,
        from: flowSteps[0].from,
        to: flowSteps[flowSteps.length - 1].to,
        carries: flowSteps[0].carries || carries,
        version: 1,
        created_at: new Date().toISOString(),
    };
}

export function executeHandover({
    flow,
    fromRole,
    toRole,
    carries = [],
    targetRoleBar = [],
    targetRoleBarVersion = 1,
}: any = {}) {
    const from = fromRole || (flow && flow.from);
    const to = toRole || (flow && flow.to);
    const evidenceCarried = Array.isArray(carries) ? carries : [];
    const bar = Array.isArray(targetRoleBar) ? targetRoleBar : [];

    const now = new Date().toISOString();

    // AC-IAM-04-03: bar is empty -> allowed with unconstrained: true
    if (bar.length === 0) {
        return {
            allowed: true,
            unconstrained: true,
            from,
            to,
            carries: evidenceCarried,
            bar_version: targetRoleBarVersion,
            timestamp: now,
            message: 'Handover allowed without constraints (unconstrained: true)',
        };
    }

    // AC-IAM-04-01 & AC-IAM-04-02: bar check (supporting string kinds or { evidence_kind, min_basis } shapes)
    function getKind(item) {
        if (!item) return '';
        if (typeof item === 'string') return item;
        return item.evidence_kind || item.kind || item.name || '';
    }

    const carriedMap = new Map();
    for (const item of evidenceCarried) {
        const kind = getKind(item);
        if (kind) {
            carriedMap.set(kind, typeof item === 'object' ? item : { evidence_kind: kind });
        }
    }

    const missing = [];
    for (const req of bar) {
        const reqKind = getKind(req);
        if (!carriedMap.has(reqKind)) {
            missing.push(reqKind || (typeof req === 'string' ? req : JSON.stringify(req)));
        } else if (typeof req === 'object' && req.min_basis) {
            const carried = carriedMap.get(reqKind);
            if (carried && (carried.basis || carried.level)) {
                const actualBasis = carried.basis || carried.level;
                const reqRank = BASIS_RANK[req.min_basis] ?? 0;
                const carriedRank = BASIS_RANK[actualBasis] ?? 0;
                if (carriedRank < reqRank) {
                    missing.push(`${reqKind} (min_basis: ${req.min_basis}, got: ${actualBasis})`);
                }
            }
        }
    }

    if (missing.length > 0) {
        const err: any = new Error(
            `HANDOFF_INCOMPLETE: Role '${from}' cannot hand over to '${to}'. Missing required evidence: ${missing.join(', ')} (bar of role '${to}')`
        );
        err.code = 'HANDOFF_INCOMPLETE';
        err.allowed = false;
        err.from = from;
        err.to = to;
        err.missing = missing;
        err.required_by_role = to;
        err.required_bar = bar;
        err.bar_version = targetRoleBarVersion;
        throw err;
    }

    // AC-IAM-04-01: Happy path
    return {
        allowed: true,
        unconstrained: false,
        from,
        to,
        carries: evidenceCarried,
        bar_version: targetRoleBarVersion,
        timestamp: now,
        message: 'Handover permitted with complete evidence bundle',
    };
}

export function inspectFlowWorkers({
    flow,
    workers = [],
}: any = {}) {
    if (!flow) {
        throw new Error('Flow is required');
    }

    const retiredInFlow = [];
    const steps = flow.steps || [];

    for (const step of steps) {
        if (step.worker_id) {
            const found = workers.find((w) => w.worker_id === step.worker_id);
            if (found && (found.state === 'retired' || found.state === 'inactive')) {
                retiredInFlow.push({
                    step_id: step.id || `${step.from}->${step.to}`,
                    worker_id: step.worker_id,
                    worker_state: found.state,
                });
            }
        }
    }

    if (retiredInFlow.length > 0) {
        return {
            ...flow,
            has_retired_workers: true,
            code: 'DANGLING_FLOW',
            status: 'REQUIRES_EDIT_OR_OPEN_RISK',
            dangling_workers: retiredInFlow,
            message: `Flow '${flow.id}' references retired worker(s): ${retiredInFlow.map((r) => r.worker_id).join(', ')}. Must edit flow or file OPEN risk.`,
        };
    }

    return {
        ...flow,
        has_retired_workers: false,
        status: 'ACTIVE',
        dangling_workers: [],
    };
}
