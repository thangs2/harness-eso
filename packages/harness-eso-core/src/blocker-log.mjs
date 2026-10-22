/**
 * The rejection trail: what a gate decided, written where the gated party cannot edit it.
 *
 * DSH's `{ kind: 'reject' }` ends a step as blocked and carries no reason, and preflight runs with
 * `writeLedger: false`. Without this file a blocked step leaves no trace at all — a decision nobody
 * can explain afterwards, which is the failure B2 describes from the other side.
 *
 * The log is append-only JSONL in **product state** (`~/.harness/eso-blockers.jsonl`, overridable with
 * `HARNESS_ESO_BLOCKER_LOG`), not in the session directory: the session is agent-writable by design,
 * so a record there proves nothing.
 *
 * Writing must never change the decision. A gate that cannot log still denies (the safe direction);
 * the failure is returned to the caller instead of thrown, and never weakens the reject.
 */
import fs from 'node:fs';
import path from 'node:path';

import { projectIdFrom } from '@mu/harness-foundation/pure';
import { productStateDir } from '@mu/harness-foundation/workspace';

export const BLOCKER_LOG_ENV = 'HARNESS_ESO_BLOCKER_LOG';

/** `~/.harness/eso-blockers.jsonl`, or the environment override. */
export function blockerLogFile() {
    const override = process.env[BLOCKER_LOG_ENV]?.trim();
    return override || path.join(productStateDir(), 'eso-blockers.jsonl');
}

function blockerView(blocker) {
    if (!blocker || typeof blocker !== 'object') return null;
    const view = { source: blocker.source ?? null, kind: blocker.kind ?? null, ref: blocker.ref ?? null };
    if (blocker.table !== undefined) view.table = blocker.table;
    if (blocker.detail !== undefined) view.detail = blocker.detail;
    return view;
}

/**
 * Append one rejection record. Returns the record and the file it landed in.
 *
 * @param {{ root?: string, projectId?: string|null, host?: string, event?: string, tool?: string|null,
 *           step?: number|null, agent?: string|null, stem?: string|null,
 *           blockers?: object[], errors?: object[], kind?: string, at?: string, file?: string }} input
 * @returns {{ record: object, file: string }}
 */
export function appendBlockerRecord(input = {}) {
    const file = input.file || blockerLogFile();
    const record = {
        at: input.at || new Date().toISOString(),
        kind: input.kind || 'rejected',
        host: input.host ?? null,
        projectId: input.projectId ?? (input.root ? projectIdFrom(input.root) || null : null),
        event: input.event ?? null,
        tool: input.tool ?? null,
        step: input.step ?? null,
        agent: input.agent ?? null,
        stem: input.stem ?? null,
        blockers: (input.blockers ?? []).map(blockerView).filter(Boolean),
        errors: (input.errors ?? []).map((error) => ({
            source: error?.source ?? null,
            detail: error?.detail ?? null,
        })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return { record, file };
}

/**
 * A recorder that never throws: the plugin path must not turn a disk problem into a different
 * decision, and a missing log line is not a reason to let a hard blocker through.
 *
 * @param {{ root?: string, file?: string, host?: string }} [options]
 * @returns {(payload: object) => { ok: boolean, file?: string, record?: object, error?: string }}
 */
export function createBlockerRecorder(options = {}) {
    const { root, file, host = 'dsh' } = options;
    return (payload = {}) => {
        try {
            // A caller that knows a more specific root (the session's consumer) wins over the default.
            const { record, file: written } = appendBlockerRecord({ ...payload, root: payload.root ?? root, file, host });
            return { ok: true, file: written, record };
        } catch (err) {
            return { ok: false, file: file || blockerLogFile(), error: err.message };
        }
    };
}

/** Read back the trail, newest last. `limit` keeps a long-lived file from filling a caller's memory. */
export function readBlockerRecords(file = blockerLogFile(), options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const lines = raw.split('\n').filter((line) => line.trim());
    return lines
        .slice(Math.max(0, lines.length - limit))
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return { unreadable: line.slice(0, 200) };
            }
        });
}
