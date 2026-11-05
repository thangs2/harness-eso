// Pure rule for Jira Story status roll-up. No network here: the CLI does the I/O.
//
// Source of truth for ESO: sdlc/07.technical/01.architecture/17.jira-slp-operating.md §6.1.
// Mirrors baplatform sdlc/00.governance/05.operating-model/05.jira/04.story-subtask-rollup.md.
// The rule is intentionally narrow: it never sets Done and never moves a parent backwards.

export const TERMINAL = new Set(['Done', 'Closed']);
export const KNOWN = new Set(['To Do', 'Backlog', 'In Progress', 'Human In Review', 'Done', 'Closed']);

/**
 * @param {string} parentStatus current Story status
 * @param {string[]} childStatuses direct child Task/Subtask statuses
 * @returns {'In Progress'|'Human In Review'|null} target status, or null for "leave alone"
 */
export function decideParentStatus(parentStatus, childStatuses) {
    const children = (childStatuses || []).filter(Boolean);
    if (!children.length) return null;
    if (!KNOWN.has(parentStatus)) return null;
    if (children.some((s) => !KNOWN.has(s))) return null;
    if (TERMINAL.has(parentStatus)) return null; // reopening Done/Closed is a human decision

    // Any child in progress ⇒ Story in progress. Reopen Human In Review if a child is reworked.
    if (children.some((s) => s === 'In Progress')) {
        return parentStatus === 'In Progress' ? null : 'In Progress';
    }

    // All children Human In Review or Done ⇒ Story Human In Review. Never Done.
    if (children.every((s) => s === 'Human In Review' || TERMINAL.has(s))) {
        return parentStatus === 'Human In Review' ? null : 'Human In Review';
    }

    // Some started + some still To Do/Backlog ⇒ Story in progress (mixed state is not review).
    const started = children.some((s) => s === 'Human In Review' || TERMINAL.has(s));
    const idle = children.some((s) => s === 'To Do' || s === 'Backlog');
    if (started && idle) return parentStatus === 'In Progress' ? null : 'In Progress';

    // All children To Do/Backlog ⇒ do not move the Story backwards.
    return null;
}
