/**
 * @mu/eso-iam — Attribute-Based Access Control Policies & Deny-Overrides Evaluator (US-IAM-03 / ESO-186 / Slice S1)
 *
 * Implements:
 * - AC-IAM-03-01: Deny-overrides combining algorithm: allow + deny matching => deny wins, recording matched policies + winner
 * - AC-IAM-03-02: Policy change by agent (direct or indirect) rejected with POLICY_CHANGE_FORBIDDEN
 * - AC-IAM-03-03: Policy with unknown attribute rejected with UNKNOWN_ATTRIBUTE at save time (0 writes)
 * - AC-IAM-03-04: Multi-tenant isolation: project A policies never apply to project B (0 matched policies)
 * - AC-IAM-03-05: Concurrent edit on stale version rejected with STALE_VERSION
 * - AC-IAM-03-06: Policy pointing to deleted attribute surfaces DANGLING_ATTRIBUTE (does not silently ignore)
 * - AC-IAM-03-07: Out-of-scope project invocation rejected with OUT_OF_SCOPE
 */

import { CLOSED_ATTRIBUTES } from './schema.mjs';

export function savePolicy({
    project,
    policy,
    previousPolicy,
    actor = 'operator',
    channel = 'direct',
    allowedAttributes = CLOSED_ATTRIBUTES,
} = {}) {
    if (!project) {
        const err = new Error('Project is required');
        err.code = 'INVALID_PROJECT';
        throw err;
    }

    if (!policy || typeof policy !== 'object') {
        const err = new Error('Policy object is required');
        err.code = 'INVALID_POLICY';
        throw err;
    }

    // AC-IAM-03-02: RBAC human-only guard
    const isAuthorized = actor === 'operator' || actor === 'human' || actor === 'A-01';
    if (!isAuthorized) {
        const err = new Error(`POLICY_CHANGE_FORBIDDEN: Actor '${actor}' cannot change policy (${channel})`);
        err.code = 'POLICY_CHANGE_FORBIDDEN';
        err.actor = actor;
        err.channel = channel;
        throw err;
    }

    // AC-IAM-03-03: Attribute existence check
    const attribute = policy.attribute;
    if (!allowedAttributes.includes(attribute)) {
        const err = new Error(`UNKNOWN_ATTRIBUTE: Attribute '${attribute}' is not defined in attribute_def`);
        err.code = 'UNKNOWN_ATTRIBUTE';
        err.attribute = attribute;
        throw err;
    }

    // AC-IAM-03-05 / ED7: Optimistic version locking
    if (previousPolicy) {
        if (policy.version <= previousPolicy.version) {
            const err = new Error(`STALE_VERSION: Target version ${policy.version} is stale (current is ${previousPolicy.version})`);
            err.code = 'STALE_VERSION';
            err.version = policy.version;
            err.current_version = previousPolicy.version;
            throw err;
        }
    }

    return {
        ...policy,
        project,
        status: policy.status || 'current',
    };
}

export function evaluatePolicies({
    project,
    target = {},
    policies = [],
    availableAttributes = CLOSED_ATTRIBUTES,
    roleContext,
} = {}) {
    // AC-IAM-03-07: Out of scope tenant check
    if (target.project && project && target.project !== project) {
        const err = new Error(`OUT_OF_SCOPE: Project '${target.project}' is outside authorized scope of '${project}'`);
        err.code = 'OUT_OF_SCOPE';
        err.target_project = target.project;
        throw err;
    }

    // AC-IAM-03-04: Multi-tenant filter: only evaluate policies belonging to this project
    const scopedPolicies = policies.filter((p) => p.project === project);

    const matched = [];
    const dangling_attributes = [];

    for (const p of scopedPolicies) {
        // AC-IAM-03-06: Check dangling attribute
        if (!availableAttributes.includes(p.attribute)) {
            dangling_attributes.push({
                policy_id: p.policy_id,
                attribute: p.attribute,
                code: 'DANGLING_ATTRIBUTE',
                message: `DANGLING_ATTRIBUTE: Policy '${p.policy_id}' targets attribute '${p.attribute}' which does not exist or was deleted`,
            });
            continue;
        }

        // Subject matching (if specified)
        if (roleContext && p.subjects && Array.isArray(p.subjects) && p.subjects.length > 0) {
            const roleMatch = p.subjects.some((s) => {
                const nameMatches = !s.role_name || s.role_name === roleContext.role_name;
                const versionMatches = s.role_version === undefined || s.role_version === roleContext.role_version;
                return nameMatches && versionMatches;
            });
            if (!roleMatch) {
                continue;
            }
        }

        // Attribute matching
        const targetVal = target[p.attribute];
        let matches = false;

        if (p.operator === 'eq') {
            matches = String(targetVal) === String(p.value);
        } else if (p.operator === 'starts_with') {
            matches = String(targetVal || '').startsWith(String(p.value));
        } else if (p.operator === 'in') {
            const values = Array.isArray(p.value) ? p.value : String(p.value).split(',');
            matches = values.map((v) => String(v).trim()).includes(String(targetVal));
        }

        if (matches) {
            matched.push(p);
        }
    }

    if (matched.length === 0) {
        return {
            effect: 'deny',
            matched: [],
            decided_by: null,
            reason: 'NO_MATCHING_POLICY',
            dangling_attributes,
        };
    }

    // AC-IAM-03-01: Deny-overrides combining algorithm
    const denyPolicy = matched.find((p) => p.effect === 'deny');
    if (denyPolicy) {
        return {
            effect: 'deny',
            matched,
            decided_by: denyPolicy.policy_id,
            dangling_attributes,
        };
    }

    const allowPolicy = matched.find((p) => p.effect === 'allow');
    return {
        effect: 'allow',
        matched,
        decided_by: allowPolicy ? allowPolicy.policy_id : null,
        dangling_attributes,
    };
}
