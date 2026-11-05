/**
 * @mu/eso-evidence — Replay Turn Query Implementation (ESO-80 / US-EV-03 / Slice S1)
 *
 * Invariants & Acceptance Criteria:
 * - AC-EV-03-01: Replay returns matching level, mode, basis, Resolved[], and FileUse[].
 * - AC-EV-03-02: File with dirty: true includes explicit note "nội dung không lấy lại được".
 * - AC-EV-03-03: Cross-project turn query returns 0 rows (null) without leaking metadata (OUT_OF_SCOPE).
 * - AC-EV-03-04 / ED1: Turn that read 0 files returns files_used: [] (empty array, NEVER null).
 * - AC-EV-03-05 / ED10: Referencing deleted file/artefact marks dangling: true and gone: true, 0 crash.
 * - Gate W2: Deterministic replay: replaying twice yields empty diff (diffReplays).
 */

/**
 * Replays a recorded turn with its elections, files read, and skill versions.
 *
 * @param {object} db Database handle
 * @param {object} params
 * @param {string} params.project Project identifier
 * @param {string} params.turn_id Turn identifier
 * @param {function} [params.fsExists] Optional filesystem verification callback
 * @returns {object|null} Replay record or null if not found/out of scope
 */
export async function replayTurn(db, { project, turn_id, fsExists = null } = {}) {
    if (!project || !turn_id) {
        throw new Error('project and turn_id are required');
    }

    const normProject = project.trim();
    const normTurnId = turn_id.trim();

    // AC-EV-03-03: Project isolation query
    const row = await db.get(
        `SELECT project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload
         FROM evidence_turn
         WHERE project = ? AND turn_id = ?`,
        [normProject, normTurnId]
    );

    if (!row) {
        return null;
    }

    const payload = JSON.parse(row.payload || '{}');

    // Fetch elections / items in sequence
    const itemRows = await db.all(
        `SELECT seq, kind, payload
         FROM evidence_item
         WHERE project = ? AND turn_id = ?
         ORDER BY seq ASC`,
        [normProject, normTurnId]
    );

    const resolved = itemRows
        .filter((r) => r.kind === 'election')
        .map((r) => JSON.parse(r.payload || '{}'));

    // AC-EV-03-04: Ensure files_used is strictly an Array (empty array if 0 files, NEVER null)
    const rawFiles = Array.isArray(payload.files_used) ? payload.files_used : [];

    // AC-EV-03-02 & AC-EV-03-05: Process each FileUse entry
    const filesUsed = rawFiles.map((file) => {
        let isDangling = false;
        if (typeof fsExists === 'function') {
            isDangling = !fsExists(file.path);
        }

        const isDirty = Boolean(file.dirty);

        return {
            path: (file.path || '').replace(/\\/g, '/'),
            content_hash: file.content_hash || file.hash || null,
            git_commit: file.git_commit || file.commit || (isDirty ? null : 'unknown'),
            dirty: isDirty,
            note: isDirty ? 'nội dung không lấy lại được (unreproducible content)' : null,
            dangling: isDangling,
            gone: isDangling,
        };
    });

    return {
        project: row.project,
        turn_id: row.turn_id,
        at: row.at,
        actor_role: row.actor_role,
        actor_status: row.actor_status,
        level: row.level,
        mode: row.mode,
        basis: row.basis,
        rule_version: row.rule_version,
        resolved,
        files_used: filesUsed,
        skill_versions: payload.skill_versions || {},
        guarantee: payload.guarantee || 'evidence-backed',
    };
}

/**
 * Gate W2 helper: verifies that two replay results have zero differences.
 *
 * @param {object} replayA First replay result
 * @param {object} replayB Second replay result
 * @returns {Array<string>} List of discrepancies (empty if identical)
 */
export function diffReplays(replayA, replayB) {
    if (!replayA && !replayB) return [];
    if (!replayA || !replayB) return ['One replay is null while the other is not'];

    const jsonA = JSON.stringify(replayA);
    const jsonB = JSON.stringify(replayB);

    if (jsonA === jsonB) return [];

    return [`Replays differ: ${jsonA} !== ${jsonB}`];
}
