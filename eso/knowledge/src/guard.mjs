/**
 * @mu/eso-knowledge — Declaration Write Guard (ESO-130 / US-KB-02 / Slice S1)
 *
 * Implements:
 * - AC-KB-02-04: Agent modifying applies_when / declaration is rejected with RULE_CHANGE_FORBIDDEN.
 * - INV-KB-02: Tri thức bền chỉ vào KB qua quyết định của người: máy không tự duyệt.
 */

export function guardDeclarationWrite({ actor_role, declaration, changes } = {}) {
    if (!actor_role || typeof actor_role !== 'string') {
        const err = new Error('RULE_CHANGE_FORBIDDEN: Actor role is required to modify declarations');
        err.code = 'RULE_CHANGE_FORBIDDEN';
        throw err;
    }

    const role = actor_role.trim().toLowerCase();
    // Only human operator or administrator can modify knowledge declarations
    if (role === 'agent' || role.startsWith('agent-') || role.startsWith('bot-')) {
        const err = new Error(`RULE_CHANGE_FORBIDDEN: Agent role '${actor_role}' is forbidden from modifying applies_when or declarations (INV-KB-02)`);
        err.code = 'RULE_CHANGE_FORBIDDEN';
        err.actor_role = actor_role;
        throw err;
    }

    return {
        allowed: true,
        actor_role,
        declaration,
    };
}
