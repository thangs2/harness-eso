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
 * Records what the repo looked like when the verdict was minted, so a later guard can tell whether the
 * ground moved since.
 *
 * This replaces the age check (G-21). `at` + `ttlSec` measured **time**, which is not a proxy for
 * "the evidence still describes this tree": a verdict stays true for as long as nothing is written, and
 * goes stale the moment something is — whether that took five seconds or five hours. An idle agent
 * was refused, a busy one was not, and neither answer had anything to do with the code.
 *
 * `git index mtime` is the cheap, per-write signal (`computeFastFingerprint`); `policyMtime` covers a
 * tree with no `.git`, which the fingerprint cannot see at all.
 *
 * @param {string} [root]
 * @returns {{ indexMtime: number, policyMtime: number }}
 */
export function computeRepoState(root = '') {
    const statMtime = (p) => {
        try {
            return fs.statSync(p).mtimeMs;
        } catch {
            return 0;
        }
    };
    if (!root) return { indexMtime: 0, policyMtime: 0 };
    return {
        indexMtime: statMtime(path.join(root, '.git', 'index')),
        policyMtime: Math.max(
            statMtime(path.join(root, '.harness', 'decision-policy.json')),
            statMtime(path.join(root, 'harness.config.json')),
        ),
    };
}

/**
 * Did the working tree change since the receipt was minted?
 *
 * Both halves are compared only when both sides carry a value: a receipt minted before this field
 * existed (or on a tree without `.git`) says nothing, and a guard must not read "unknown" as "changed"
 * — that would refuse every write in a consumer with no git metadata, which is the defect G-21 is
 * fixing, not a stricter version of it.
 *
 * @param {object} receipt
 * @param {{ indexMtime: number, policyMtime: number }} current
 * @returns {boolean}
 */
export function repoStateChanged(receipt, current) {
    const was = receipt?.repoState;
    if (!was || typeof was !== 'object') return false;
    for (const key of ['indexMtime', 'policyMtime']) {
        const before = Number(was[key]);
        const now = Number(current?.[key]);
        if (Number.isFinite(before) && before > 0 && Number.isFinite(now) && now > 0 && now !== before) {
            return true;
        }
    }
    return false;
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
        /**
         * Whether `enforceWrites` was written by the consumer or supplied by the strict default (G-08),
         * and the gaps no reading in this repo can close (G-02). The guard's deny message reads both; a
         * verdict that omits them forces the guard to describe a refusal from fields it does not have.
         *
         * Reported only, never decided on: these two keys are outside the MAC's field list (see
         * `computeReceiptMac`), so a receipt minted by an older pack stays valid and simply says nothing.
         */
        enforceWritesSource: input?.enforceWritesSource === 'default' ? 'default' : 'declared',
        /**
         * Who minted this receipt. `pack` (the default, and what every existing receipt means) is a
         * docgraph/codegraph measurement; `dsh-plugin-checks` is a smaller claim — the consumer's declared
         * checks found no blocker — which the DSH plugin can honestly make and a reader must not mistake
         * for a score. Outside the MAC's field list like the two above, so an older receipt that omits it
         * stays valid and reads as `pack`.
         *
         * It also decides who may rewrite the file: a host plugin must never overwrite a measured receipt
         * with a weaker check-only one.
         */
        source: typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : 'pack',
        /**
         * Brain-tier evidence recorded by a host that witnesses the model call itself.
         *
         * On Cursor/Antigravity the Brain evidence is the DeepSeek ledger, written by the MCP server. A
         * host whose sandbox stops that child from reaching product state cannot produce a ledger row at
         * all, and pointing the ledger somewhere the child can write would put forgeable evidence inside
         * the agent's reach. So the DSH plugin records `{ ok, at, via, brainTier }` here instead, from its
         * own `tools/post-execute` listener — a process the agent cannot drive.
         *
         * Read by `guard-write.py` before it falls back to the ledger. Outside the MAC's field list, like
         * `source` and `enforceWritesSource`, so a receipt minted by an older pack stays valid.
         */
        brain:
            input?.brain && typeof input.brain === 'object' && input.brain.ok === true && input.brain.at
                ? {
                      ok: true,
                      at: String(input.brain.at),
                      via: input.brain.via ? String(input.brain.via) : 'unknown',
                      brainTier: input.brain.brainTier ? String(input.brain.brainTier) : null,
                  }
                : null,
        unanswerableGaps: Array.isArray(input?.unanswerableGaps)
            ? input.unanswerableGaps.filter((g) => g && typeof g === 'object' && g.id).map((g) => ({ id: String(g.id) }))
            : [],
        /**
         * Which paths had their *evidence* deferred this turn (G-20), and whether `partial` publishes
         * nothing at all here. The guard matches the first against the write target; the second decides
         * whether "close the remaining gaps" is advice it can follow. Outside the MAC field list, like
         * the two above: they describe a policy the receipt carries, not a measurement to protect.
         */
        deferWrite: {
            paths: Array.isArray(input?.deferWrite?.paths)
                ? input.deferWrite.paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
                : [],
            mode: input?.deferWrite?.mode === 'evidence' ? 'evidence' : 'evidence',
        },
        jevOnPartial: input?.jevOnPartial === true,
        /**
         * The tree this verdict describes: git index mtime and the policy files' mtime (G-21). Compared,
         * not aged — see `repoStateChanged`. Inside the MAC's field list is not necessary (the value is
         * `stat()` at mint time and cannot be guessed usefully), and keeping it out means a receipt
         * minted by an older pack stays valid.
         */
        repoState:
            input?.repoState && typeof input.repoState === 'object'
                ? {
                      indexMtime: Number(input.repoState.indexMtime) || 0,
                      policyMtime: Number(input.repoState.policyMtime) || 0,
                  }
                : null,
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
 * Checks existence, allowWrite, HMAC signature, and whether the tree changed since the receipt was
 * minted (G-21).
 *
 * Age is **not** a reason to reject. `ttlSec` stays on the receipt as a diagnostic and stops deciding
 * anything: a verdict about a tree that has not been written to is still true an hour later, and one
 * about a tree that has been rewritten is false a second later. `repoState` answers that; the clock
 * only answered "how long since we last asked", which is a different fact.
 *
 * @param {string} projectId
 * @param {string|null} [currentFingerprint]
 * @param {object} [opts] — `root` enables the tree-changed check; absent it is skipped, not assumed.
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
        // A receipt from the future is a broken clock, not a verdict — still rejected, still named.
        return { valid: false, reason: 'clock_skew', ageSec, ttlSec, receipt: doc };
    }

    if (opts.root && repoStateChanged(doc, computeRepoState(opts.root))) {
        return { valid: false, reason: 'repo_changed', ageSec, ttlSec, receipt: doc };
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
