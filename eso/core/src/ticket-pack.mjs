import { createHash } from 'node:crypto';

/**
 * @mu/eso-core — Ticket Ingestion & Execution Pack Management
 *
 * Covers:
 * - US-TICKET-01 (ESO-243): Ticket pack extraction (AC, scope, verify command, forbidden),
 *   RBAC Done refusal, 200 AC retention (ED3), verbatim ticket key (ED9).
 * - US-TICKET-02 (ESO-310): Missing field diagnostics (ac, scope, verify, forbidden),
 *   all 4 listed on empty ticket (ED1), deleted parent reporting (ED10), no guessing.
 * - US-TICKET-03 (ESO-248): Ticket source resolution (jira, local, none), no-tool fallback,
 *   idempotent single record per turn (ED6), deleted branch reporting (ED10).
 * - US-TICKET-04 (ESO-253): Historical pack audit by turn, SHA-256 content_hash integrity,
 *   tamper/drift detection, non-destructive versioning (ED3), dangling cites tracking.
 */

export const REQUIRED_PACK_SECTIONS = Object.freeze(['ac', 'scope', 'verify', 'forbidden']);

function canonicalJson(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalJson).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function computeHash(content) {
    return createHash('sha256').update(typeof content === 'string' ? content : canonicalJson(content)).digest('hex');
}

export function generateExecutionPack({
    ticketKey,
    ticketData = {},
    source = 'jira',
    localFile = null,
    actorRole = 'operator',
    existingTurnPacks = [],
    turnId = null,
} = {}) {
    // AC-TICKET-01-06 / ED9: Preserve ticket key verbatim without case folding or trimming
    const key = ticketKey !== undefined && ticketKey !== null ? String(ticketKey) : '';

    // AC-TICKET-03-02: Neither tool nor local file -> source: none, missing: ['ticket-source']
    if ((source === 'none' || !source) && !localFile) {
        // AC-TICKET-03-04 / ED6: Idempotency if called twice in same turn
        if (turnId) {
            const existingNone = existingTurnPacks.find((p) => p.turn_id === turnId && p.source === 'none');
            if (existingNone) return existingNone;
        }

        return {
            status: 'incomplete',
            ticket_key: key,
            turn_id: turnId,
            source: 'none',
            is_ready: false,
            missing: ['ticket-source'],
            message: 'Không có tool ticket và không có file local',
            created_at: new Date().toISOString(),
        };
    }

    // AC-TICKET-03-01: Local file source
    const effectiveSource = localFile ? 'local' : source;

    // Diagnose missing sections (US-TICKET-02)
    const missing = [];

    // AC-TICKET-02-04 / ED1: Check all 4 sections independently, do not stop at first
    const acList = Array.isArray(ticketData.ac) ? ticketData.ac : (ticketData.ac ? [ticketData.ac] : []);
    if (acList.length === 0) {
        missing.push('ac'); // AC-TICKET-02-02: Never guessed
    }

    const scopeList = Array.isArray(ticketData.scope) ? ticketData.scope : (ticketData.scope ? [ticketData.scope] : []);
    if (scopeList.length === 0) {
        missing.push('scope');
    }

    const verifyCmd = ticketData.verify || ticketData.verify_command;
    if (!verifyCmd || typeof verifyCmd !== 'string' || verifyCmd.trim() === '') {
        missing.push('verify'); // AC-TICKET-02-01
    }

    const forbiddenList = Array.isArray(ticketData.forbidden) ? ticketData.forbidden : (ticketData.forbidden ? [ticketData.forbidden] : []);
    if (forbiddenList.length === 0) {
        missing.push('forbidden');
    }

    // AC-TICKET-02-05 / ED10: Deleted parent ticket
    const unknowns = [];
    if (ticketData.parent && ticketData.parent.deleted) {
        missing.push(`parent đã mất: ${ticketData.parent.id || ticketData.parent.key}`);
        unknowns.push({ kind: 'deleted_parent', parent_id: ticketData.parent.id || ticketData.parent.key });
    }

    // AC-TICKET-03-05 / ED10: Local file referencing deleted branch/sprint
    if (localFile && localFile.deleted_branch) {
        missing.push(`nhánh/sprint đã mất: ${localFile.deleted_branch}`);
        unknowns.push({ kind: 'deleted_branch', branch: localFile.deleted_branch });
    }

    // If any section is missing -> incomplete pack (AC-TICKET-01-02, AC-TICKET-02-03)
    if (missing.length > 0) {
        return {
            status: 'incomplete',
            ticket_key: key,
            source: effectiveSource,
            is_ready: false,
            missing,
            unknowns,
            message: `Ticket '${key}' chưa đủ; thiếu: ${missing.join(', ')}`,
            created_at: new Date().toISOString(),
        };
    }

    // AC-TICKET-01-07: Untraceable / orphan value in pack
    if (ticketData.has_orphan_value || ticketData.orphan_value) {
        const err = new Error(`ORPHAN_VALUE: Pack contains untraceable value '${ticketData.orphan_value || 'unknown'}'`);
        err.code = 'ORPHAN_VALUE';
        err.orphan_value = ticketData.orphan_value;
        throw err;
    }

    // AC-TICKET-01-01 & AC-TICKET-01-05 / ED3: Keep all ACs (e.g. 200 ACs intact)
    const packBody = {
        ticket_key: key,
        source: effectiveSource,
        ac: [...acList],
        scope: [...scopeList],
        verify_command: verifyCmd.trim(),
        forbidden: [...forbiddenList],
        domain_spec: ticketData.domain_spec || null,
        summary: ticketData.summary || key,
    };

    const contentHash = computeHash(packBody);

    return {
        status: 'ready',
        is_ready: true,
        ticket_key: key,
        source: effectiveSource,
        version: ticketData.version || 1,
        content_hash: contentHash,
        pack: packBody,
        missing: [],
        unknowns: [],
        created_at: new Date().toISOString(),
    };
}

export function setTicketDoneStatus({
    ticketKey,
    actorRole = 'agent',
} = {}) {
    // AC-TICKET-01-04 / RBAC: Agent is strictly forbidden from marking ticket done
    if (actorRole !== 'operator' && actorRole !== 'human' && actorRole !== 'admin') {
        const err = new Error(`DONE_FORBIDDEN: Agent role '${actorRole}' is prohibited from marking ticket '${ticketKey}' as Done`);
        err.code = 'DONE_FORBIDDEN';
        err.ticket_key = ticketKey;
        err.role = actorRole;
        throw err;
    }

    return {
        ticket_key: ticketKey,
        status: 'Done',
        marked_by: actorRole,
        at: new Date().toISOString(),
    };
}

export function queryHistoricalPack({
    turnId,
    turnPackRecords = [],
    currentTicketData = null,
} = {}) {
    if (!turnId) throw new Error('turnId is required');

    // AC-TICKET-04-04 / ED1: Turn did not use any pack -> returns null / empty
    const matched = turnPackRecords.find((r) => r.turn_id === turnId);
    if (!matched) {
        return {
            turn_id: turnId,
            found: false,
            pack: null,
            message: 'turn không dùng pack nào',
        };
    }

    const pack = matched.pack;
    const recordedHash = matched.content_hash;
    const computedHash = computeHash(pack);

    // AC-TICKET-04-02: Pack was modified after use -> hash mismatch detected
    const isTampered = recordedHash !== computedHash;

    // AC-TICKET-04-06: AC modified after pack creation
    let acDrift = false;
    if (currentTicketData && currentTicketData.ac) {
        const curAcJson = JSON.stringify(currentTicketData.ac);
        const packAcJson = JSON.stringify(pack.ac);
        if (curAcJson !== packAcJson) {
            acDrift = true;
        }
    }

    // AC-TICKET-04-07: Broken citation in pack -> flagged dangling in unknowns
    const unknowns = [];
    if (pack.cites) {
        for (const cite of pack.cites) {
            if (cite.broken || cite.deleted) {
                unknowns.push({ kind: 'dangling_cite', cite: cite.path || cite.id });
            }
        }
    }

    return {
        turn_id: turnId,
        found: true,
        pack,
        recorded_hash: recordedHash,
        hash_matched: !isTampered,
        tampered: isTampered,
        ac_drift: acDrift,
        unknowns,
    };
}

export async function createTicketPackStore({ db = null } = {}) {
    const memoryRecords = [];

    if (db) {
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS ticket_pack (
                project      TEXT NOT NULL,
                source       TEXT NOT NULL,
                ticket_key   TEXT,
                tried        TEXT NOT NULL DEFAULT '[]',
                fetched_at   TIMESTAMPTZ NOT NULL,
                content_hash TEXT NOT NULL,
                pack         TEXT NOT NULL,
                PRIMARY KEY (project, source, fetched_at)
            );
            CREATE OR REPLACE FUNCTION ticket_pack_append_only()
            RETURNS TRIGGER AS $$
            BEGIN
                RAISE EXCEPTION 'FORBIDDEN_MUTATION: ticket_pack is strictly append-only (no UPDATE/DELETE)';
            END;
            $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS trg_ticket_pack_no_change ON ticket_pack;
            CREATE TRIGGER trg_ticket_pack_no_change
            BEFORE UPDATE OR DELETE ON ticket_pack
            FOR EACH ROW EXECUTE FUNCTION ticket_pack_append_only();
        `;
        await db.exec(createTableSql);
    }

    return {
        async appendPack({
            project,
            source = 'jira',
            ticket_key = null,
            tried = [],
            fetched_at = new Date().toISOString(),
            pack,
            content_hash = null,
        } = {}) {
            if (!project) throw new Error('project is required');
            if (!source) throw new Error('source is required');
            if (!pack || typeof pack !== 'object') throw new Error('pack object is required');

            const computed = computeHash(pack);
            if (content_hash && content_hash !== computed) {
                const err = new Error(`PACK_TAMPERED: Provided content_hash '${content_hash}' does not match computed hash '${computed}'`);
                err.code = 'PACK_TAMPERED';
                err.provided_hash = content_hash;
                err.computed_hash = computed;
                throw err;
            }

            const record = {
                project,
                source,
                ticket_key: ticket_key !== undefined ? ticket_key : null,
                tried: Array.isArray(tried) ? tried : [],
                fetched_at,
                content_hash: computed,
                pack,
            };

            if (db) {
                const sql = `
                    INSERT INTO ticket_pack (project, source, ticket_key, tried, fetched_at, content_hash, pack)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                const params = [
                    record.project,
                    record.source,
                    record.ticket_key,
                    JSON.stringify(record.tried),
                    record.fetched_at,
                    record.content_hash,
                    JSON.stringify(record.pack),
                ];
                try {
                    await db.run(sql, ...params);
                } catch (e) {
                    if (e.code === '23505' || (e.message && (e.message.includes('UNIQUE') || e.message.includes('PRIMARY KEY')))) {
                        const err = new Error(`IMMUTABLE_RECORD: ticket_pack is append-only and cannot overwrite existing primary key`);
                        err.code = 'IMMUTABLE_RECORD';
                        throw err;
                    }
                    throw e;
                }
            } else {
                const exists = memoryRecords.some(
                    (r) => r.project === project && r.source === source && r.fetched_at === fetched_at
                );
                if (exists) {
                    const err = new Error(`IMMUTABLE_RECORD: ticket_pack is append-only and cannot overwrite existing record`);
                    err.code = 'IMMUTABLE_RECORD';
                    throw err;
                }
                memoryRecords.push(JSON.parse(JSON.stringify(record)));
            }

            return record;
        },

        async getPacks({ project, ticket_key = null, source = null } = {}) {
            if (!project) throw new Error('project is required');

            let records = [];
            if (db) {
                let sql = `SELECT * FROM ticket_pack WHERE project = ?`;
                const params = [project];
                if (ticket_key !== null && ticket_key !== undefined) {
                    sql += ` AND ticket_key = ?`;
                    params.push(ticket_key);
                }
                if (source !== null && source !== undefined) {
                    sql += ` AND source = ?`;
                    params.push(source);
                }
                sql += ` ORDER BY fetched_at ASC`;
                let rows = [];
                rows = await db.all(sql, ...params);
                records = rows.map((r) => {
                    const packObj = JSON.parse(r.pack);
                    const computed = computeHash(packObj);
                    if (computed !== r.content_hash) {
                        const err = new Error(`PACK_TAMPERED: Recorded hash '${r.content_hash}' does not match computed hash '${computed}'`);
                        err.code = 'PACK_TAMPERED';
                        err.recorded_hash = r.content_hash;
                        err.computed_hash = computed;
                        throw err;
                    }
                    return {
                        project: r.project,
                        source: r.source,
                        ticket_key: r.ticket_key,
                        tried: JSON.parse(r.tried || '[]'),
                        fetched_at: r.fetched_at,
                        content_hash: r.content_hash,
                        pack: packObj,
                    };
                });
            } else {
                records = memoryRecords
                    .filter((r) => {
                        if (r.project !== project) return false;
                        if (ticket_key !== null && ticket_key !== undefined && r.ticket_key !== ticket_key) return false;
                        if (source !== null && source !== undefined && r.source !== source) return false;
                        return true;
                    })
                    .map((r) => {
                        const computed = computeHash(r.pack);
                        if (computed !== r.content_hash) {
                            const err = new Error(`PACK_TAMPERED: Recorded hash '${r.content_hash}' does not match computed hash '${computed}'`);
                            err.code = 'PACK_TAMPERED';
                            err.recorded_hash = r.content_hash;
                            err.computed_hash = computed;
                            throw err;
                        }
                        return JSON.parse(JSON.stringify(r));
                    });
            }

            return records;
        },

        async getLatestPack({ project, ticket_key = null, source = null } = {}) {
            const list = await this.getPacks({ project, ticket_key, source });
            if (list.length === 0) return null;
            return list[list.length - 1];
        },

        verifyIntegrity(record) {
            if (!record || !record.pack || !record.content_hash) {
                const err = new Error('INVALID_RECORD: Record must contain pack and content_hash');
                err.code = 'INVALID_RECORD';
                throw err;
            }
            const computed = computeHash(record.pack);
            if (computed !== record.content_hash) {
                const err = new Error(`PACK_TAMPERED: Recorded hash '${record.content_hash}' does not match computed hash '${computed}'`);
                err.code = 'PACK_TAMPERED';
                err.recorded_hash = record.content_hash;
                err.computed_hash = computed;
                throw err;
            }
            return {
                valid: true,
                content_hash: computed,
            };
        },

        update() {
            const err = new Error('FORBIDDEN_MUTATION: ticket_pack is strictly append-only (no UPDATE)');
            err.code = 'FORBIDDEN_MUTATION';
            throw err;
        },

        delete() {
            const err = new Error('FORBIDDEN_MUTATION: ticket_pack is strictly append-only (no DELETE)');
            err.code = 'FORBIDDEN_MUTATION';
            throw err;
        },
    };
}
