/**
 * Ingest the gate trail (`<product state>/eso-blockers.jsonl`) into `gate_event`.
 *
 * Why this exists: the host does not log the decisions it makes when it blocks a tool or a step, and
 * the plugin writes them to a product-state file that the Observatory could not read. That left the
 * product's central promise — "a blocked action is auditable" — as a `tail` command.
 *
 * Idempotent by `(project_id, source_path, source_line_no)`: re-reading the file is free, and an
 * append-only file only ever grows.
 */
import fs from 'node:fs';

import { isoNow } from '@mu/harness-foundation/pure';

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} db
 * @param {{ project: { id: string }, gateTrailPath?: string }} cfg
 * @returns {{ ok: boolean, path: string|null, lines?: number, inserted?: number, skipped?: number, reason?: string }}
 */
export function ingestGateTrail(db, cfg) {
    const file = cfg.gateTrailPath;
    if (!file) return { ok: false, path: null, reason: 'no gate trail path' };
    if (!fs.existsSync(file)) return { ok: true, path: file, lines: 0, inserted: 0, skipped: 0, absent: true };

    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return { ok: false, path: file, reason: err.message };
    }

    const projectId = cfg.project.id;
    const now = isoNow();
    const storedBefore = numberOrNull(db.get('SELECT COUNT(*) AS n FROM gate_event WHERE project_id = ?', [projectId])?.n) ?? 0;
    let skipped = 0;
    const lines = text.split('\n').filter((line) => line.trim());

    lines.forEach((line, index) => {
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            skipped += 1;
            return;
        }
        /*
         * The trail is global (one file for every project). A record belongs to this database only when
         * it names this project; a record with no project id cannot be attributed, so it is counted as
         * skipped rather than guessed into whichever project asks first.
         */
        if (record.projectId !== projectId) {
            skipped += 1;
            return;
        }
        const first = Array.isArray(record.blockers) ? record.blockers[0] : null;
        db.run(
            `INSERT OR IGNORE INTO gate_event
                (project_id, at, kind, host, event, tool, ref, detail, blockers_json, raw_json, source_path, source_line_no, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                projectId,
                record.at || null,
                record.kind || 'unknown',
                record.host || null,
                record.event || null,
                record.tool || null,
                first?.ref ?? null,
                first?.detail ?? null,
                JSON.stringify(record.blockers ?? []),
                line,
                file,
                index + 1,
                now,
            ],
        );
    });

    const stored = numberOrNull(db.get('SELECT COUNT(*) AS n FROM gate_event WHERE project_id = ?', [projectId])?.n) ?? 0;
    /* `INSERT OR IGNORE` reports nothing, so the delta is the only honest count of what is new. */
    return { ok: true, path: file, lines: lines.length, inserted: Math.max(0, stored - storedBefore), skipped, stored };
}
