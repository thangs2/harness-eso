/**
 * Promax flow evidence: prompt attachments + enriched hook paths (observe API).
 */

const FILE_PATH_KEYS = ['file_path', 'path', 'target_file', 'notebook_path', 'absolute_path'];

export function relPath(rootPath, p) {
    const root = String(rootPath || '').replace(/\\/g, '/');
    let s = String(p || '').replace(/\\/g, '/');
    if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
    return s;
}

export function extractPathFromRecord(rec) {
    if (!rec || typeof rec !== 'object') return '';
    if (rec.path) return String(rec.path);
    const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
    const input = payload.tool_input || rec.tool_input;
    if (input && typeof input === 'object') {
        for (const k of FILE_PATH_KEYS) {
            if (typeof input[k] === 'string' && input[k]) return input[k];
        }
    }
    return '';
}

function parseRawJson(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

function addAttachment(map, type, filePath) {
    const fp = String(filePath || '').trim();
    if (!fp) return;
    const key = fp.replace(/\\/g, '/');
    if (!map.has(key)) map.set(key, { type: type || 'rule', filePath: key });
}

function attachmentsFromRecord(rec) {
    const out = [];
    if (!rec) return out;
    for (const a of rec.attachments || []) {
        if (!a || typeof a !== 'object') continue;
        const fp = a.file_path || a.path || a.file || a.id;
        if (fp) out.push({ type: a.type || a.kind || 'rule', filePath: String(fp) });
    }
    for (const rf of rec.ruleFiles || []) {
        if (rf) out.push({ type: 'rule', filePath: String(rf) });
    }
    const payload = rec.payload;
    if (payload && Array.isArray(payload.attachments)) {
        for (const a of payload.attachments) {
            if (!a || typeof a !== 'object') continue;
            const fp = a.file_path || a.path;
            if (fp) out.push({ type: a.type || 'rule', filePath: String(fp) });
        }
    }
    return out;
}

/**
 * @param {import('./db.mjs').Db} db
 * @param {string} projectId
 * @param {object} request
 */
export function loadAttachedForRequest(db, projectId, request) {
    const map = new Map();
    const genId = request.generation_id || null;
    const requestId = request.id;

    const mergeRows = (rows) => {
        for (const row of rows || []) {
            addAttachment(map, row.type, row.filePath);
        }
    };

    mergeRows(
        db.all(
            `SELECT DISTINCT json_extract(a.value, '$.type') AS type,
                    json_extract(a.value, '$.file_path') AS filePath
             FROM event e, json_each(e.raw_json, '$.attachments') a
             WHERE e.request_id = ? AND json_extract(a.value, '$.file_path') IS NOT NULL
             ORDER BY filePath`,
            [requestId],
        ),
    );

    if (genId) {
        mergeRows(
            db.all(
                `SELECT DISTINCT json_extract(a.value, '$.type') AS type,
                        json_extract(a.value, '$.file_path') AS filePath
                 FROM event e, json_each(e.raw_json, '$.attachments') a
                 WHERE e.project_id = ? AND e.generation_id = ?
                   AND json_extract(a.value, '$.file_path') IS NOT NULL
                 ORDER BY filePath`,
                [projectId, genId],
            ),
        );
        mergeRows(
            db.all(
                `SELECT DISTINCT 'rule' AS type, rf.value AS filePath
                 FROM event e, json_each(e.raw_json, '$.ruleFiles') rf
                 WHERE e.project_id = ? AND e.generation_id = ? AND rf.value IS NOT NULL`,
                [projectId, genId],
            ),
        );
        const promptRows = db.all(
            `SELECT raw_json FROM event
             WHERE project_id = ? AND generation_id = ?
               AND event_type IN ('beforeSubmitPrompt', 'preInvocation', 'PreInvocation')
             ORDER BY hook_at DESC LIMIT 8`,
            [projectId, genId],
        );
        for (const row of promptRows) {
            for (const a of attachmentsFromRecord(parseRawJson(row.raw_json))) {
                addAttachment(map, a.type, a.filePath);
            }
        }
    }

    if (!map.size && request.conversation_id && request.started_at) {
        mergeRows(
            db.all(
                `SELECT DISTINCT json_extract(a.value, '$.type') AS type,
                        json_extract(a.value, '$.file_path') AS filePath
                 FROM event e, json_each(e.raw_json, '$.attachments') a
                 WHERE e.project_id = ? AND e.conversation_id = ?
                   AND e.event_type IN ('beforeSubmitPrompt', 'preInvocation', 'PreInvocation')
                   AND json_extract(a.value, '$.file_path') IS NOT NULL
                   AND replace(e.hook_at, 'Z', '') >= replace(?, 'Z', '')
                   AND replace(e.hook_at, 'Z', '') <= replace(COALESCE(?, e.hook_at), 'Z', '')
                 ORDER BY filePath`,
                [projectId, request.conversation_id, request.started_at, request.ended_at || request.started_at],
            ),
        );
    }

    const rules = db.all('SELECT rule_id AS ruleId FROM request_rule WHERE request_id = ?', [requestId]);
    for (const r of rules) addAttachment(map, 'rule', r.ruleId);

    if (genId) {
        const hp = db.get(
            'SELECT rules_json FROM hook_prompt WHERE project_id = ? AND generation_id = ?',
            [projectId, genId],
        );
        if (hp?.rules_json) {
            try {
                const list = JSON.parse(hp.rules_json);
                if (Array.isArray(list)) {
                    for (const rule of list) addAttachment(map, 'rule', rule);
                }
            } catch {
                /* ignore */
            }
        }
    }

    return [...map.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * @param {object[]} rows from DB (include raw_json)
 * @param {string} [rootPath]
 */
export function enrichRequestEvents(rows, rootPath) {
    return (rows || []).map((row) => {
        const rec = parseRawJson(row.raw_json);
        let path = row.path || '';
        let command = row.command || '';
        if (rec) {
            if (!path) path = extractPathFromRecord(rec) || '';
            if (!command) {
                const payload = rec.payload || {};
                const input = payload.tool_input || rec.tool_input || {};
                command =
                    input.command ||
                    jsonExtractCommand(rec) ||
                    jsonExtractCommand(payload) ||
                    '';
            }
        }
        const rel = relPath(rootPath, path);
        return {
            harness: row.harness,
            eventType: row.eventType,
            tool: row.tool,
            path: rel || path || '',
            hookAt: row.hookAt,
            command: command ? String(command) : '',
            synthetic: row.synthetic,
        };
    });
}

function jsonExtractCommand(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const input = obj.tool_input || obj.payload?.tool_input;
    if (input && typeof input.command === 'string') return input.command;
    return '';
}
