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

function computeHash(content) {
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
