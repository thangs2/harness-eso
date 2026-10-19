/**
 * Attestations — evidence a guard can trust about a decision it did not make.
 *
 * ## Why this exists
 *
 * A gate has to read something to decide, and that something must not be writable by the party being
 * gated. Both of this repo's gates were reading files the agent writes:
 *
 *   - `guard-write.py`'s evidence gate read `.eso-bundle-stamp.json` and stopped blocking on
 *     `allowWrite: true`. The pack computes that value and writes `.eso-preflight.json`; the *stamp* was
 *     the agent's to write, and a real incident had the agent write one claiming `allowWrite: true`, a
 *     score of `0.85` where preflight had computed `0.37`, and a `hilWaiver` string for a field that
 *     exists nowhere in this codebase.
 *   - The Brain gate read `.pipeline-brain-stamp.json`, which the rules tell the agent to write itself.
 *
 * An attestation moves both to **product state**, which is where the operator's state lives and which
 * both guards now deny writes to. The writers are then processes a human does not operate:
 *
 * | attestation | writer | why it can be believed |
 * |---|---|---|
 * | ESO evidence | the pack's own preflight hook | a hook, not a tool call — it runs outside the agent's Write/Shell path |
 * | Brain call | the DeepSeek MCP server's usage ledger | the only process that knows a model call actually completed |
 *
 * ## What is and is not claimed
 *
 * Not unforgeable. An agent with shell access runs as the same user and could write here if a guard were
 * bypassed. What is claimed is narrower and worth having: **the honest path no longer requires the agent
 * to write its own permission**, and the casual forgery — editing a stamp in the session directory next to
 * files it legitimately writes — no longer works.
 *
 * The Brain attestation has one limitation that must not be papered over: the ledger is **machine-wide**,
 * because an MCP server is handed a prompt and nothing else — no conversation, no generation. So it can
 * attest "a Brain-tier call completed recently", not "for this turn". The accurate per-turn join exists in
 * the observer, which matches `sha256(prompt)` between transcript and ledger; that is not available at
 * gate time. A cross-project false positive is therefore possible and is stated rather than hidden.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { productStateDir } from './workspace-store.mjs';

/** Roles the DeepSeek server writes for a Brain-tier call. Mirrors `callDeepSeek`'s role argument. */
export const BRAIN_ROLES = ['pro', 'brain_flash', 'brain_fallback'];

/** How recent a Brain call must be to satisfy the gate. Mirrors the old stamp's `STAMP_MAX_AGE_SECONDS`. */
export const ATTEST_MAX_AGE_SECONDS = 30 * 60;

export function attestDir() {
    return path.join(productStateDir(), 'attest');
}

/**
 * The consumer's project id, read from its `harness.config.json`.
 *
 * Reads the file directly rather than through the config loader: this runs inside a hook on every
 * prompt, the loader pulls in the whole policy stack, and the one field needed is a top-level string.
 *
 * @param {string} root consumer repo root
 * @returns {string} '' when unreadable — callers must treat that as "no project", not as a default
 */
export function projectIdFrom(root) {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8'));
        return String(cfg?.project?.id || '');
    } catch {
        return '';
    }
}

export function esoAttestationFile(projectId) {
    return path.join(attestDir(), `${projectId}.json`);
}

/**
 * The DeepSeek MCP server's append-only usage ledger. One line per completed model call.
 *
 * Kept in product state so a guard can reach it and an agent's write path cannot — see `consent.mjs` for
 * the same reasoning applied to consent records.
 */
export function usageLedgerFile() {
    const override = process.env.DEEPSEEK_USAGE_LEDGER?.trim();
    return override || path.join(productStateDir(), 'deepseek-usage.jsonl');
}

/**
 * Read the ESO evidence attestation for a project.
 *
 * @param {string} projectId
 * @returns {{ ok: boolean, allowWrite?: boolean, level?: string, score?: number, enforceWrites?: string, at?: string, generationId?: string | null } | null}
 */
export function readEsoAttestation(projectId) {
    if (!projectId) return null;
    try {
        const doc = JSON.parse(fs.readFileSync(esoAttestationFile(projectId), 'utf8'));
        return doc && typeof doc === 'object' ? doc : null;
    } catch {
        return null;
    }
}

/**
 * Retrieve or generate machine/project secret for signing attestations.
 *
 * @param {string} [projectId]
 * @returns {string}
 */
export function getAttestationSecret(projectId = '') {
    if (process.env.HARNESS_ATTEST_SECRET) {
        return process.env.HARNESS_ATTEST_SECRET;
    }
    const secretPath = path.join(productStateDir(), '.attest_secret');
    try {
        if (fs.existsSync(secretPath)) {
            const sec = fs.readFileSync(secretPath, 'utf8').trim();
            if (sec) return sec;
        }
    } catch {
        /* best-effort read */
    }
    try {
        fs.mkdirSync(productStateDir(), { recursive: true });
        const generated = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretPath, generated, { mode: 0o600 });
        return generated;
    } catch {
        return crypto.createHash('sha256').update(`harness-eso:${projectId || 'default'}`).digest('hex');
    }
}

/**
 * Computes an HMAC-SHA256 signature for a Sufficiency Receipt doc.
 *
 * @param {object} doc
 * @param {string} [secret]
 * @returns {string}
 */
export function computeReceiptMac(doc, secret) {
    if (!doc || typeof doc !== 'object') return '';
    const sec = secret || getAttestationSecret(doc.projectId);
    const invStr = Array.isArray(doc.invIds) ? doc.invIds.join(',') : '';
    const scoreStr = typeof doc.score === 'number' ? Number(doc.score).toFixed(2) : '0.00';
    const ttlStr = String(doc.ttlSec ?? 600);
    const macData = [
        String(doc.projectId || ''),
        String(doc.at || ''),
        String(doc.fingerprint || ''),
        invStr,
        String(doc.allowWrite === true),
        String(doc.level || ''),
        scoreStr,
        ttlStr,
    ].join('|');
    return crypto.createHmac('sha256', sec).update(macData).digest('hex');
}

/**
 * Record the pack's evidence verdict as a signed Sufficiency Receipt.
 * Called by the preflight hook or gap closer — never by a tool call.
 *
 * @param {string} projectId
 * @param {object} input
 * @param {string} [secret]
 */
export function writeEsoAttestation(projectId, input, secret = undefined) {
    if (!projectId) throw new Error('attestation needs a project id');
    const dir = attestDir();
    fs.mkdirSync(dir, { recursive: true });
    const sec = secret || getAttestationSecret(projectId);
    const ttlSec = Number.isFinite(input?.ttlSec) ? Number(input.ttlSec) : 600;
    const invIds = Array.isArray(input?.invIds)
        ? input.invIds
        : (Array.isArray(input?.pinnedInvariants) ? input.pinnedInvariants : []);

    const doc = {
        ok: true,
        projectId,
        at: input?.at || new Date().toISOString(),
        generationId: input?.generationId ? String(input.generationId) : null,
        level: input?.level ?? 'unknown',
        score: typeof input?.score === 'number' ? input.score : null,
        // The field the gate actually consumes. Named for what it means rather than for how the old
        // session stamp spelled it, so a reader cannot mistake it for the agent's own claim.
        allowWrite: input?.allowWrite === true,
        enforceWrites: input?.enforceWrites ?? null,
        mode: input?.mode ?? null,
        fingerprint: input?.fingerprint ? String(input.fingerprint) : null,
        invIds,
        ttlSec,
    };
    doc.mac = computeReceiptMac(doc, sec);

    const file = esoAttestationFile(projectId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return doc;
}

/**
 * Verify a Sufficiency Receipt on disk in Product State.
 * Checks existence, allowWrite, TTL, fingerprint, and HMAC signature.
 *
 * @param {string} projectId
 * @param {string|null} [currentFingerprint]
 * @param {object} [opts]
 * @returns {{ valid: boolean, reason?: string, receipt?: object, ageSec?: number, ttlSec?: number }}
 */
export function verifySufficiencyReceipt(projectId, currentFingerprint = null, opts = {}) {
    if (!projectId) return { valid: false, reason: 'missing_project_id' };
    const doc = readEsoAttestation(projectId);
    if (!doc || typeof doc !== 'object') {
        return { valid: false, reason: 'missing_receipt' };
    }

    if (doc.allowWrite !== true) {
        return { valid: false, reason: 'allow_write_false', receipt: doc };
    }

    const nowMs = opts.now instanceof Date
        ? opts.now.getTime()
        : (typeof opts.now === 'number' ? opts.now : Date.now());
    const atMs = Date.parse(doc.at);
    const ttlSec = Number(doc.ttlSec ?? 600);
    if (!Number.isFinite(atMs)) {
        return { valid: false, reason: 'invalid_timestamp', receipt: doc };
    }
    const ageSec = (nowMs - atMs) / 1000;
    if (ageSec < -120) {
        return { valid: false, reason: 'clock_skew', ageSec, ttlSec, receipt: doc };
    }
    if (ageSec > ttlSec) {
        return { valid: false, reason: 'expired', ageSec, ttlSec, receipt: doc };
    }

    if (currentFingerprint && doc.fingerprint) {
        if (doc.fingerprint !== currentFingerprint) {
            return { valid: false, reason: 'fingerprint_mismatch', receipt: doc };
        }
    }

    const sec = opts.secret || getAttestationSecret(projectId);
    const expectedMac = computeReceiptMac(doc, sec);
    if (!doc.mac || doc.mac !== expectedMac) {
        return { valid: false, reason: 'mac_mismatch', receipt: doc };
    }

    return { valid: true, receipt: doc };
}

/**
 * Did a Brain-tier model call complete within the max age?
 *
 * Reads the ledger tail. The file is append-only and grows without bound, so only the last lines are
 * examined — a Brain call recent enough to satisfy the gate is necessarily near the end, and reading a
 * multi-megabyte file on every guarded write is not acceptable.
 *
 * @param {{ now?: Date, maxAgeSeconds?: number, maxBytes?: number }} [opts]
 * @returns {{ ok: boolean, role?: string, at?: string }}
 */
export function brainAttested(opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const maxAge = Number.isFinite(opts.maxAgeSeconds) ? Number(opts.maxAgeSeconds) : ATTEST_MAX_AGE_SECONDS;
    const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : 64 * 1024;
    const file = usageLedgerFile();

    let text;
    try {
        const stat = fs.statSync(file);
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            text = buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return { ok: false };
    }

    const lines = text.split('\n').filter(Boolean);
    // The first line of a tail read is usually a fragment of a record; it will fail to parse and be
    // skipped, which is the right outcome.
    let newest = null;
    for (const line of lines) {
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (!BRAIN_ROLES.includes(String(rec?.role || ''))) continue;
        const at = Date.parse(String(rec?.at || ''));
        if (!Number.isFinite(at)) continue;
        if (!newest || at > Date.parse(String(newest.at))) newest = { role: String(rec.role), at: rec.at, ms: at };
    }
    if (!newest) return { ok: false };
    const ageSeconds = (now.getTime() - newest.ms) / 1000;
    // A record from the future means a clock problem; refusing is safer than treating it as fresh.
    if (ageSeconds < -120) return { ok: false };
    if (ageSeconds > maxAge) return { ok: false };
    return { ok: true, role: newest.role, at: newest.at };
}
