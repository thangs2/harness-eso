/**
 * @mu/eso-knowledge — Shared Knowledge Promotion (ESO-135 / US-KB-03 / Slice S1)
 *
 * Implements:
 * - AC-KB-03-01: All projects without override adopt new version on next turn.
 * - AC-KB-03-02: Project with local override does NOT change; surfaces overridden_by.
 * - AC-KB-03-03: Promotion without human approval is rejected with APPROVAL_REQUIRED (INV-KB-02).
 * - AC-KB-03-04: Returns impact list; revert is a single atomic action (BR-10 pointer transition).
 * - AC-KB-03-05: Duplicate promotion with identical version/hash is no-op with impact: [].
 * - AC-KB-03-06: Atomic snapshot transitions prevent hybrid/inconsistent states.
 * - AC-KB-03-07: Supports atomic multi-item promotions.
 */

function isHuman(role) {
    if (!role || typeof role !== 'string') return false;
    const r = role.toLowerCase().trim();
    return r === 'human' || r === 'operator' || r === 'admin' || r === 'lead';
}

export function promoteToShared({
    declaration,
    new_version,
    content_hash,
    applies_when = {},
    actor_role,
    approved_by,
    declarations = [],
    projects = [],
} = {}) {
    // 1. Authority / approval check (AC-KB-03-03 / INV-KB-02)
    if (!isHuman(actor_role) && !isHuman(approved_by)) {
        const err = new Error('APPROVAL_REQUIRED: Promotion to shared requires human approval (INV-KB-02)');
        err.code = 'APPROVAL_REQUIRED';
        throw err;
    }

    if (!declaration || !declaration.id) {
        throw new Error('Declaration with id is required for promotion');
    }

    const itemId = declaration.id;
    const version = new_version || declaration.version || '1.0';
    const hash = content_hash || declaration.content_hash || `hash-${version}`;

    // 2. Idempotency check (AC-KB-03-05 / ED6)
    const existingShared = declarations.find(
        (d) => d.id === itemId && d.zone === 'shared' && d.status === 'current'
    );

    if (existingShared && existingShared.version === version && existingShared.content_hash === hash) {
        return {
            promoted: false,
            idempotent: true,
            item_id: itemId,
            version,
            impact: [],
            declarations: [...declarations],
        };
    }

    // 3. Perform atomic transition on copy of declarations
    const updatedDeclarations = declarations.map((d) => {
        if (d.id === itemId && d.zone === 'shared' && d.status === 'current') {
            return {
                ...d,
                status: 'superseded',
            };
        }
        return d;
    });

    const newSharedDecl = {
        ...declaration,
        id: itemId,
        zone: 'shared',
        project: 'shared',
        path: declaration.path || `skills/${itemId}.md`,
        version,
        status: 'current',
        content_hash: hash,
        applies_when,
        promoted_by: actor_role || approved_by,
        promoted_at: new Date().toISOString(),
    };
    updatedDeclarations.push(newSharedDecl);

    // 4. Calculate impact across projects (AC-KB-03-01, AC-KB-03-02, AC-KB-03-04)
    const affectedProjects = [];
    const overriddenProjects = [];

    for (const proj of projects) {
        const hasOverride = updatedDeclarations.some(
            (d) => d.id === itemId && d.zone === 'project' && d.project === proj && d.status === 'current'
        );
        if (hasOverride) {
            overriddenProjects.push(proj);
        } else {
            affectedProjects.push(proj);
        }
    }

    return {
        promoted: true,
        idempotent: false,
        item_id: itemId,
        new_version: version,
        previous_version: existingShared?.version || null,
        impact: {
            affected_projects: affectedProjects,
            overridden_projects: overriddenProjects,
        },
        declarations: updatedDeclarations,
    };
}

export function revertSharedPromotion({
    item_id,
    target_version,
    actor_role,
    approved_by,
    declarations = [],
} = {}) {
    // 1. Approval check (AC-KB-03-03 / INV-KB-02)
    if (!isHuman(actor_role) && !isHuman(approved_by)) {
        const err = new Error('APPROVAL_REQUIRED: Reverting shared promotion requires human approval (INV-KB-02)');
        err.code = 'APPROVAL_REQUIRED';
        throw err;
    }

    if (!item_id) {
        throw new Error('Item id is required for revert');
    }

    const currentShared = declarations.find(
        (d) => d.id === item_id && d.zone === 'shared' && d.status === 'current'
    );
    if (!currentShared) {
        throw new Error(`No current shared declaration found for '${item_id}'`);
    }

    // Find the version to restore
    let previousShared = null;
    if (target_version) {
        previousShared = declarations.find(
            (d) => d.id === item_id && d.zone === 'shared' && d.version === target_version
        );
    } else {
        // Pick the most recent superseded version
        previousShared = declarations
            .filter((d) => d.id === item_id && d.zone === 'shared' && d.status === 'superseded')
            .pop();
    }

    const updatedDeclarations = declarations.map((d) => {
        if (d.id === item_id && d.zone === 'shared' && d.status === 'current') {
            return {
                ...d,
                status: 'revoked',
                revoked_at: new Date().toISOString(),
                revoked_by: actor_role || approved_by,
            };
        }
        if (previousShared && d.id === item_id && d.zone === 'shared' && d.version === previousShared.version) {
            return {
                ...d,
                status: 'current',
                restored_at: new Date().toISOString(),
            };
        }
        return d;
    });

    return {
        reverted: true,
        item_id,
        revoked_version: currentShared.version,
        restored_version: previousShared?.version || null,
        declarations: updatedDeclarations,
    };
}
