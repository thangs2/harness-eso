/**
 * Consent records — the human half of the `ask` path tier.
 *
 * `ask` means "this path is not the agent's to decide". Without a place for a human to say yes, the
 * tier can only lie: enforced as a deny it is a brick, enforced as an allow it is decoration. This is
 * that place.
 *
 * ## Where the record lives, and why that is the whole point
 *
 * Product state — `~/.harness/consent/<projectId>.json` — **not** the repo. The repo's session
 * directory (`.cursor/session/`) has to be agent-writable, because the Brain stamp and the preflight
 * bundle are written there by the agent's own hooks. Anything an agent can write, an agent can forge:
 * a real incident had the agent write `.eso-bundle-stamp.json` with `allowWrite: true`, a score of
 * `0.85` where preflight had computed `0.37`, and a `hilWaiver` string claiming "user approved" — a
 * field that exists nowhere in this codebase. A consent file beside those stamps would be worth
 * nothing.
 *
 * So the record lives where the agent's write gates do not reach, and the migration of consent out of
 * `.eso-consent-waiver.json` (session dir) is part of this change rather than a follow-up.
 *
 * ## What this cannot do, stated plainly
 *
 * An agent with shell access runs as the same user. It can `cat` this file, and if a guard is ever
 * bypassed it could write one. There is no signature here because there is no key an agent cannot
 * read — inventing one would be security theatre. What this record buys is:
 *
 *   1. **A writer that is not the agent.** The console writes it, on a human's click.
 *   2. **A closed set of writers.** Both guards deny writes into product state, so the ordinary channels
 *      are shut rather than merely unwatched.
 *   3. **An audit trail.** `approvedBy` plus the timestamp lands in the record, so an out-of-band
 *      approval is visible as out-of-band instead of being indistinguishable from the normal path.
 *
 * If a stronger guarantee is wanted the next step is not a fancier file: it is to have the guard ask a
 * process (the console) over a socket, so the decision never touches the filesystem the agent can write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathMatches } from './path-policy.mjs';
import { productStateDir } from './workspace-store.mjs';

/** Where consent records live, under product state. */
export const CONSENT_DIR_NAME = 'consent';

/** @returns {string} the consent directory (`<product state>/consent`) */
export function consentDir() {
    return path.join(productStateDir(), CONSENT_DIR_NAME);
}

/** @param {string} projectId */
export function consentFile(projectId) {
    return path.join(consentDir(), `${projectId}.json`);
}

/**
 * @param {string} projectId
 * @returns {{ version: number, projectId: string, records: object[] }}
 */
export function readConsentStore(projectId) {
    const file = consentFile(projectId);
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const records = Array.isArray(raw?.records) ? raw.records : [];
        return { version: 1, projectId, records };
    } catch {
        // Absent or unreadable is "no consent", never "consent" — the only safe direction.
        return { version: 1, projectId, records: [] };
    }
}

/**
 * @param {string} projectId
 * @param {object[]} records
 */
function writeConsentStore(projectId, records) {
    const file = consentFile(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc = { version: 1, projectId, records, updatedAt: new Date().toISOString() };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return doc;
}

function normaliseRel(p) {
    let rel = String(p || '').trim().replace(/\\/g, '/');
    while (rel.startsWith('./')) rel = rel.slice(2);
    return rel;
}

/**
 * Record a human approval.
 *
 * @param {string} projectId
 * @param {{ path: string, approvedBy?: string, reason?: string, ttlSeconds?: number, requestId?: string }} input
 * @returns {object} the stored record
 */
export function grantConsent(projectId, input) {
    const target = normaliseRel(input?.path);
    if (!target) throw new Error('consent needs a path');
    const now = new Date();
    const ttl = Number.isFinite(input?.ttlSeconds) && input.ttlSeconds > 0 ? Number(input.ttlSeconds) : 30 * 60;
    const record = {
        id: `c_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        path: target,
        // Recorded rather than assumed. `console` is the only writer today; naming it lets a future
        // out-of-band approval be told apart from a normal one.
        approvedBy: String(input?.approvedBy || 'human:console'),
        reason: input?.reason ? String(input.reason) : '',
        requestId: input?.requestId ? String(input.requestId) : null,
        at: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    };
    const store = readConsentStore(projectId);
    // Newest first, and one live record per path: re-approving extends rather than accumulating, so the
    // file stays readable and "what is currently approved" has a single answer.
    const kept = store.records.filter((r) => normaliseRel(r?.path) !== target);
    writeConsentStore(projectId, [record, ...kept]);
    return record;
}

/**
 * Revoke by path or by record id.
 * @param {string} projectId
 * @param {{ path?: string, id?: string }} sel
 */
export function revokeConsent(projectId, sel) {
    const target = normaliseRel(sel?.path);
    const store = readConsentStore(projectId);
    const kept = store.records.filter((r) => {
        if (sel?.id) return r?.id !== sel.id;
        return normaliseRel(r?.path) !== target;
    });
    const removed = store.records.length - kept.length;
    writeConsentStore(projectId, kept);
    return { removed };
}

/** Live records only: an expired approval is not an approval. */
export function liveConsents(projectId, now = new Date()) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    return readConsentStore(projectId)
        .records.filter((r) => {
            const exp = Date.parse(r?.expiresAt || '');
            if (!Number.isFinite(exp)) return false;
            return exp > t;
        })
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Does a live approval cover this path?
 *
 * @param {string} projectId
 * @param {string} target repo-relative path
 * @param {Date} [now]
 * @returns {{ ok: boolean, record?: object }}
 */
export function consentCovers(projectId, target, now = new Date()) {
    const rel = normaliseRel(target);
    if (!rel) return { ok: false };
    // Same matcher the path policy uses, so an approval and the gate agree about what it covers.
    // Two rules here is how one channel would refuse a write the other allowed for the same target.
    const hit = liveConsents(projectId, now).find((r) => pathMatches(rel, normaliseRel(r.path)));
    return hit ? { ok: true, record: hit } : { ok: false };
}
