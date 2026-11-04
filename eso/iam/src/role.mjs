/**
 * @mu/eso-iam — Role, Scope & Bar Management (US-IAM-02 / ESO-181 / Slice S1)
 *
 * Implements:
 * - AC-IAM-02-01: Create open role with capabilities, scope, and bar (evidence_kind + min_basis)
 * - AC-IAM-02-02: Agent role with empty bar rejected with EMPTY_OBLIGATION (0 roles saved)
 * - AC-IAM-02-03: Two roles with different bar yield different levels on same task, differing on bar deficit
 * - AC-IAM-02-04: Agent attempting to change worker role rejected with ROLE_CHANGE_FORBIDDEN (0 changes)
 * - AC-IAM-02-05: Verb in scope outside closed set rejected with UNKNOWN_VERB
 * - AC-IAM-02-06: Agent role without capabilities rejected with EMPTY_ROLE
 * - AC-IAM-02-07: Role pointing to missing/deleted policy flags DANGLING_POLICY
 */

import { CLOSED_VERBS, BASIS_RANK } from './schema.mjs';

export function createRole({
    project,
    name,
    version = 1,
    capabilities = [],
    scope = [],
    bar = [],
    status = 'current',
    role_type = 'agent',
    policies = [],
} = {}) {
    if (!project) {
        const err = new Error('Project is required');
        err.code = 'INVALID_PROJECT';
        throw err;
    }

    if (!name) {
        const err = new Error('Role name is required');
        err.code = 'INVALID_ROLE_NAME';
        throw err;
    }

    // AC-IAM-02-06 / ED1: Empty capabilities for agent role
    if (role_type === 'agent') {
        if (!capabilities || !Array.isArray(capabilities) || capabilities.length === 0) {
            const err = new Error(`EMPTY_ROLE: Agent role '${name}' must declare at least one capability (vai rỗng vô nghĩa)`);
            err.code = 'EMPTY_ROLE';
            err.role = name;
            throw err;
        }

        // AC-IAM-02-02: Empty bar obligation for agent role
        if (!bar || !Array.isArray(bar) || bar.length === 0) {
            const err = new Error(`EMPTY_OBLIGATION: Agent role '${name}' cannot have empty bar obligations (vai không đòi gì thì không cưỡng chế được gì)`);
            err.code = 'EMPTY_OBLIGATION';
            err.role = name;
            throw err;
        }
    }

    // AC-IAM-02-05: Validate closed verbs in scope
    const allowedVerbsSet = new Set(CLOSED_VERBS);
    if (Array.isArray(scope)) {
        for (const s of scope) {
            if (s.verb && !allowedVerbsSet.has(s.verb)) {
                const err = new Error(`UNKNOWN_VERB: Verb '${s.verb}' in role scope is not in closed verb set [${CLOSED_VERBS.join(', ')}]`);
                err.code = 'UNKNOWN_VERB';
                err.verb = s.verb;
                throw err;
            }
        }
    }

    // AC-IAM-02-01: Validate bar items have evidence_kind and min_basis
    if (Array.isArray(bar)) {
        for (const item of bar) {
            if (!item.evidence_kind || !item.min_basis) {
                const err = new Error('INVALID_BAR: Each bar item must define evidence_kind and min_basis');
                err.code = 'INVALID_BAR';
                throw err;
            }
        }
    }

    return {
        project,
        name,
        version,
        capabilities,
        scope,
        bar,
        status,
        policies,
    };
}

export function changeWorkerRole({
    worker,
    newRole,
    actor = 'operator',
} = {}) {
    if (!worker || typeof worker !== 'object') {
        const err = new Error('Worker object is required');
        err.code = 'INVALID_WORKER';
        throw err;
    }

    // AC-IAM-02-04: Agent actor changing role is strictly forbidden
    const isAuthorized = actor === 'operator' || actor === 'human' || actor === 'A-01';
    if (!isAuthorized) {
        const err = new Error(`ROLE_CHANGE_FORBIDDEN: Actor '${actor}' cannot change worker role (agent không được tự đổi role)`);
        err.code = 'ROLE_CHANGE_FORBIDDEN';
        err.actor = actor;
        throw err;
    }

    return {
        ...worker,
        role_name: newRole,
    };
}

export function evaluateRoleSufficiency({
    role,
    evidence = [],
} = {}) {
    if (!role || !Array.isArray(role.bar)) {
        return { level: 'unknown', deficits: [] };
    }

    const deficits = [];

    for (const req of role.bar) {
        const matchingEvidence = evidence.find(
            (e) => (e.kind === req.evidence_kind || e.evidence_kind === req.evidence_kind)
        );

        if (!matchingEvidence) {
            deficits.push({
                evidence_kind: req.evidence_kind,
                required_basis: req.min_basis,
                actual_basis: 'none',
                reason: 'MISSING_EVIDENCE',
            });
            continue;
        }

        const actualRank = BASIS_RANK[matchingEvidence.basis || matchingEvidence.level] || 0;
        const requiredRank = BASIS_RANK[req.min_basis] || 0;

        if (actualRank < requiredRank) {
            deficits.push({
                evidence_kind: req.evidence_kind,
                required_basis: req.min_basis,
                actual_basis: matchingEvidence.basis || matchingEvidence.level,
                reason: 'INSUFFICIENT_BASIS',
            });
        }
    }

    const isSufficient = deficits.length === 0;
    return {
        role: role.name,
        level: isSufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
        deficits,
    };
}

export function checkRolePolicies({
    role,
    availablePolicies = [],
} = {}) {
    if (!role || !Array.isArray(role.policies) || role.policies.length === 0) {
        return { valid: true, dangling: [] };
    }

    const dangling = [];
    for (const policyRef of role.policies) {
        const policyName = typeof policyRef === 'string' ? policyRef : policyRef.name;
        const found = availablePolicies.find(
            (p) => (p.name === policyName || p.id === policyName) && p.status !== 'deleted'
        );
        if (!found) {
            dangling.push(policyName);
        }
    }

    if (dangling.length > 0) {
        return {
            valid: false,
            code: 'DANGLING_POLICY',
            dangling,
            message: `DANGLING_POLICY: Role '${role.name}' references policy '${dangling.join(', ')}' which is missing or deleted`,
        };
    }

    return { valid: true, dangling: [] };
}
