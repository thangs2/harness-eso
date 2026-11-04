/**
 * @mu/eso-core — Turn Diagnosis & "Why" Verdict Explanation (ESO-110 / US-SUF-04 / Slice S1)
 *
 * Implements:
 * - AC-SUF-04-01: Four-part response: unmet requirements, missing evidence, prior conclusion, and unknowns[].
 * - AC-SUF-04-02: Surfaces any unknown items in unknowns[].
 * - AC-SUF-04-03: If turn record is missing, returns/throws NO_RECORD ("không có bản ghi"), never synthesizes new verdict.
 * - AC-SUF-04-04 (ED1): Turn that read 0 files states "không có bằng chứng" + unknowns entry, never infers evidence.
 * - AC-SUF-04-05 (ED10): Turn referencing deleted file notes file is gone ("file không còn / nguồn đã mất"),
 *   flags it as unknown (not absent), never synthesizes new verdict.
 *
 * Invariants:
 * - BR-05: unknown != absent.
 * - BR-06: Read-only, append-only records remain immutable.
 * - D-46: Reads recorded history, never imports Judge to re-evaluate on today's state.
 * - cites[]: stable addressing by { project, turn_id, seq, target, key, kind }.
 * - unknowns[]: ALWAYS present (even when empty).
 */

function queryGet(db, sql, params = []) {
    if (!db) return null;
    if (typeof db.get === 'function') return db.get(sql, params);
    if (typeof db.prepare === 'function') return db.prepare(sql).get(...params);
    return null;
}

function queryAll(db, sql, params = []) {
    if (!db) return [];
    if (typeof db.all === 'function') return db.all(sql, params);
    if (typeof db.prepare === 'function') return db.prepare(sql).all(...params);
    return [];
}

/**
 * Explains why a recorded turn received its verdict by inspecting the immutable record.
 *
 * @param {object} params
 * @param {object} [params.db] Database handle (optional if turnRecord provided)
 * @param {string} params.project Project identifier
 * @param {string} params.turn_id Turn identifier
 * @param {object} [params.turnRecord] In-memory turn row for direct testing
 * @param {Array} [params.items] In-memory evidence items for direct testing
 * @param {function} [params.fsExists] Filesystem verification callback
 * @returns {object} Diagnosis report
 */
export function explainTurnVerdict({
    db = null,
    project,
    turn_id,
    turnRecord = null,
    items = null,
    fsExists = null,
} = {}) {
    if (!project || !turn_id) {
        throw new Error('project and turn_id are required');
    }

    const normProject = project.trim();
    const normTurnId = turn_id.trim();

    // 1. Fetch record (or use provided mock record)
    let row = turnRecord;
    if (!row && db) {
        row = queryGet(
            db,
            `SELECT project, turn_id, at, actor_role, actor_status, level, mode, basis, rule_version, payload
             FROM evidence_turn
             WHERE project = ? AND turn_id = ?`,
            [normProject, normTurnId]
        );
    }

    // AC-SUF-04-03: Missing record -> NO_RECORD
    if (!row) {
        const err = new Error('NO_RECORD: không có bản ghi cho turn');
        err.code = 'NO_RECORD';
        err.status = 404;
        throw err;
    }

    let payload = {};
    try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    } catch {
        payload = {};
    }

    // Fetch items
    let itemRows = items;
    if (!itemRows && db) {
        itemRows = queryAll(
            db,
            `SELECT seq, kind, payload
             FROM evidence_item
             WHERE project = ? AND turn_id = ?
             ORDER BY seq ASC`,
            [normProject, normTurnId]
        );
    }
    itemRows = itemRows || [];

    const requirements = Array.isArray(payload.requirements) ? payload.requirements : [];
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const filesUsed = Array.isArray(payload.files_used) ? payload.files_used : [];

    const answersMap = new Map();
    for (const a of answers) {
        if (a && a.requirement) {
            answersMap.set(a.requirement, a);
        }
    }

    // 2. Part 1: Unmet requirements (đòi hỏi không đạt)
    const unmet = [];
    const allCites = [];

    for (const req of requirements) {
        const ans = answersMap.get(req.subject);
        const isSat = ans && ans.exists === 'present' && (ans.basis === 'verified' || ans.basis === req.min_basis);

        if (!isSat) {
            const citeReq = {
                target: `requirements[${req.subject}]`,
                where: { project: normProject, turn_id: normTurnId, seq: 1 },
                key: 'min_basis',
                kind: 'requirement',
            };
            allCites.push(citeReq);

            const cites = [citeReq];
            if (ans) {
                const citeAns = {
                    target: `answers[${req.subject}]`,
                    where: { project: normProject, turn_id: normTurnId, seq: 1 },
                    key: 'exists',
                    kind: 'answer',
                };
                allCites.push(citeAns);
                cites.push(citeAns);
            }

            unmet.push({
                subject: req.subject,
                asks: req.asks,
                min_basis: req.min_basis,
                source: req.source,
                reason: ans ? (ans.reason || (ans.exists === 'absent' ? 'bằng chứng thiếu' : 'không xác định được')) : 'bằng chứng thiếu',
                cites,
            });
        }
    }

    // 3. Part 2: Missing evidence (bằng chứng thiếu)
    const missingEvidence = [];
    for (const ans of answers) {
        if (ans.exists === 'absent') {
            const cite = {
                target: `answers[${ans.requirement}]`,
                where: { project: normProject, turn_id: normTurnId, seq: 1 },
                key: 'exists',
                kind: 'answer',
            };
            allCites.push(cite);
            missingEvidence.push({
                requirement: ans.requirement,
                claim: ans.claim,
                status: 'absent',
                cites: [cite],
            });
        }
    }

    // 4. Part 3: Prior conclusion (kết luận cũ) - read directly, NEVER recomputed
    const priorConclusion = {
        level: row.level,
        mode: row.mode,
        basis: row.basis,
        at: row.at,
        rule_version: row.rule_version,
    };

    // 5. Part 4: Unknowns[] (luôn có mặt, kể cả khi rỗng)
    const unknowns = [];

    // Prior unknowns from recorded payload
    if (Array.isArray(payload.unknowns)) {
        for (const u of payload.unknowns) {
            unknowns.push({
                what: u.what,
                reason: u.reason,
            });
        }
    }

    // Unknown answers from turn
    for (const ans of answers) {
        if (ans.exists === 'unknown' && !unknowns.some((u) => u.what === ans.requirement)) {
            unknowns.push({
                what: ans.requirement,
                reason: ans.reason || 'đòi hỏi không tra được',
                exists: 'unknown',
            });
        }
    }

    // AC-SUF-04-04 (ED1): Turn that read 0 files
    let evidenceNote;
    if (filesUsed.length === 0) {
        evidenceNote = 'không có bằng chứng';
        if (!unknowns.some((u) => u.what === 'evidence')) {
            unknowns.push({
                what: 'evidence',
                reason: 'turn không đọc file nào, không có bằng chứng',
            });
        }
    }

    // AC-SUF-04-05 (ED10): Turn referenced a file that is now gone
    for (const f of filesUsed) {
        const filePath = typeof f === 'string' ? f : f.path;
        const isGone = Boolean(f.gone || f.dangling || (fsExists && !fsExists(filePath)));

        if (isGone) {
            if (!unknowns.some((u) => u.what === filePath)) {
                unknowns.push({
                    what: filePath,
                    reason: 'file không còn (nguồn đã mất)',
                    exists: 'unknown', // AC-SUF-04-05: marked as unknown, NOT absent
                });
            }
        }
    }

    return {
        turn_id: normTurnId,
        project: normProject,
        unmet,
        missing_evidence: missingEvidence,
        prior_conclusion: priorConclusion,
        unknowns,
        cites: allCites,
        evidence_empty: filesUsed.length === 0,
        evidence_note: evidenceNote,
    };
}
