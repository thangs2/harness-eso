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
 * Record the pack's evidence verdict. Called by the preflight hook — never by a tool call.
 *
 * @param {string} projectId
 * @param {object} input
 */
export function writeEsoAttestation(projectId, input) {
    if (!projectId) throw new Error('attestation needs a project id');
    const dir = attestDir();
    fs.mkdirSync(dir, { recursive: true });
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
    };
    const file = esoAttestationFile(projectId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return doc;
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
