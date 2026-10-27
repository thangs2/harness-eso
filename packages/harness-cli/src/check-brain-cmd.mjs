/**
 * `harnessctl check brain` — is the Brain gate's evidence path actually alive?
 *
 * Why this exists: the Brain gate's primary evidence is the DeepSeek usage ledger in product state, and
 * the one failure that disables it is silent. A sandbox that stops the MCP child process from writing
 * that file produces no error a guard can see — `brain_attested()` simply returns `{}`, the gate denies,
 * and the denial names the Brain tier rather than the unwritten file. Measured on DSH: the ledger's last
 * record was three days old while the consumer believed Brain was configured.
 *
 * The check answers the three questions the fix in the root-cause note depends on, and it answers them
 * separately because they fail separately:
 *
 *   1. **Does the ledger exist, and when was the last Brain record?** — the evidence itself.
 *   2. **Do the two sides resolve the same path?** — `DEEPSEEK_USAGE_LEDGER` is read by the hook, by the
 *      MCP server (which cannot import the product) and by the ingest. Setting it for only one of them
 *      leaves the gate reading a file nobody writes, which looks exactly like a broken gate.
 *   3. **Is it fresh enough to satisfy the 30-minute window?** — a stale ledger is the ordinary failure,
 *      and it reads identically to a missing one in the deny message.
 *
 * Read-only. It never writes the ledger; a check that wrote evidence would be the defect it measures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRAIN_ROLES, readEsoAttestation, usageLedgerFile } from '@mu/harness-foundation/pure';

/** Mirrors `STAMP_MAX_AGE_SECONDS` in `guard-write.py` and `ATTEST_MAX_AGE_SECONDS` in `attest.mjs`. */
export const BRAIN_WINDOW_SECONDS = 30 * 60;

/**
 * Resolve the ledger independently of the product's resolver, the way `guard-write.py` does.
 *
 * Duplicated on purpose: this function's job is to be a **second opinion**. Calling the same helper the
 * hook's behaviour is derived from would confirm that helper, not that the hook and the MCP server agree.
 * The ordering — env override, then product state — is the contract all three readers keep.
 */
export function resolveLedgerIndependently(env = process.env) {
    const override = String(env.DEEPSEEK_USAGE_LEDGER || '').trim();
    if (override) return { path: override, source: 'DEEPSEEK_USAGE_LEDGER' };
    const stateDir = String(env.HARNESS_PRODUCT_STATE_DIR || '').trim() || path.join(os.homedir(), '.harness');
    return { path: path.join(stateDir, 'deepseek-usage.jsonl'), source: 'product state' };
}

/**
 * The newest Brain-tier record in a ledger, and how old it is.
 *
 * Reads the whole file rather than the tail: the tail is what the guard does on the hot path, and a
 * check that can be fooled by a large file would report "no record" for a ledger that has one.
 *
 * @param {string} filePath
 * @param {{ roles?: readonly string[], now?: Date }} [opts]
 */
export function surveyLedger(filePath, opts = {}) {
    const roles = new Set(opts.roles ?? BRAIN_ROLES);
    const now = opts.now instanceof Date ? opts.now : new Date();
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return { exists: false, readable: false, error: err?.code || String(err), brainRecords: 0, newest: null };
    }
    let brainRecords = 0;
    let newest = null;
    let malformed = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try {
            rec = JSON.parse(trimmed);
        } catch {
            malformed += 1;
            continue;
        }
        if (!roles.has(String(rec?.role || ''))) continue;
        brainRecords += 1;
        const at = Date.parse(String(rec?.at || ''));
        if (!Number.isFinite(at)) continue;
        if (!newest || at > newest.ms) newest = { at: rec.at, ms: at, role: rec.role, model: rec.model ?? null };
    }
    const ageSeconds = newest ? Math.round((now.getTime() - newest.ms) / 1000) : null;
    // A future timestamp is a clock problem, not freshness — the guard refuses it, so this reports it.
    const fresh = ageSeconds !== null && ageSeconds >= -120 && ageSeconds <= BRAIN_WINDOW_SECONDS;
    return { exists: true, readable: true, bytes: Buffer.byteLength(text), lines: text.split('\n').length, malformed, brainRecords, newest, ageSeconds, fresh };
}

/**
 * Brain evidence recorded by a host that witnesses the model call, if this consumer has any.
 *
 * Kept separate from the ledger survey because the two answer different questions: the ledger says "a
 * Brain call happened somewhere on this machine", the attestation says "this session's call returned".
 * A check that merged them would report one source's staleness as the other's failure.
 *
 * @param {string} [consumer]
 */
export function readWitnessedBrain(consumer) {
    try {
        const root = consumer || process.cwd();
        const projectId = String((JSON.parse(fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8'))?.project?.id) || '');
        if (!projectId) return { used: false };
        const doc = readEsoAttestation(projectId);
        const brain = doc?.brain;
        if (!brain || brain.ok !== true || !brain.at) return { used: false, source: doc?.source ?? null };
        const ageSeconds = Math.round((Date.now() - Date.parse(brain.at)) / 1000);
        return {
            used: true,
            source: String(doc.source || 'unknown'),
            at: brain.at,
            brainTier: brain.brainTier ?? null,
            ageSeconds,
            fresh: Number.isFinite(ageSeconds) && ageSeconds >= -120 && ageSeconds <= BRAIN_WINDOW_SECONDS,
        };
    } catch {
        return { used: false };
    }
}

/**
 * @param {{ consumer?: string, json?: boolean }} [opts]
 */
export function checkBrain(opts = {}) {
    const productPath = usageLedgerFile();
    const independent = resolveLedgerIndependently();
    const survey = surveyLedger(independent.path);

    /*
     * The product's own resolver is the authority for the hook and the ingest — it is the function both
     * of them call. A disagreement here means one of the two readers is looking somewhere else, and no
     * amount of "the file is fine" makes the gate work.
     */
    const samePath = path.resolve(productPath) === path.resolve(independent.path);

    /*
     * A host that witnesses Brain calls itself (DSH) records them in the product-state attestation, not in
     * the ledger — its sandbox gives the MCP child no way to write that file. Reporting a missing ledger
     * there would be a false alarm about a gate that is in fact working, so the attestation is consulted
     * first and, when it carries a Brain record, is what decides.
     */
    const witness = readWitnessedBrain(opts.consumer);

    const findings = [];
    if (witness.used) {
        if (!witness.fresh) {
            findings.push({
                id: 'brain-witness-stale',
                detail:
                    `the host records Brain calls itself (source "${witness.source}"); the newest is ${witness.ageSeconds}s old. ` +
                    `Make one Brain-tier call (ask_deepseek_pro) — it is recorded automatically, there is no stamp to write.`,
            });
        }
        return {
            verdict: findings.length ? 'fail' : 'pass',
            ledger: { path: independent.path, source: independent.source, productPath, samePath },
            witness,
            survey,
            windowSeconds: BRAIN_WINDOW_SECONDS,
            findings,
        };
    }
    if (!survey.exists) {
        findings.push({
            id: 'ledger-missing',
            detail:
                `${independent.path} does not exist. The MCP server never wrote it — under a sandbox this is the ` +
                `usual cause (the MCP child cannot reach ${independent.source}). Point DEEPSEEK_USAGE_LEDGER at a ` +
                'path both the MCP child and the hook can reach, or widen the sandbox for that child.',
        });
    } else if (!survey.brainRecords) {
        findings.push({
            id: 'no-brain-records',
            detail: `${independent.path} has ${survey.lines} line(s) but none with role in ${[...BRAIN_ROLES].join('|')}.`,
        });
    } else if (!survey.fresh) {
        findings.push({
            id: 'ledger-stale',
            detail:
                `newest Brain record is ${survey.ageSeconds}s old, outside the ${BRAIN_WINDOW_SECONDS}s window. ` +
                'Make one Brain call, then re-run this check: the line count must move.',
        });
    }
    if (!samePath) {
        findings.push({
            id: 'ledger-path-disagreement',
            detail:
                `the product resolves ${productPath} but this check resolved ${independent.path}. ` +
                'DEEPSEEK_USAGE_LEDGER must be identical for the hook, the MCP server and the ingest.',
        });
    }
    if (survey.malformed) {
        findings.push({
            id: 'ledger-malformed-lines',
            detail: `${survey.malformed} unparseable line(s); a half-flushed last line is normal, more is not.`,
        });
    }

    const verdict = findings.some((f) => f.id !== 'ledger-malformed-lines') ? 'fail' : 'pass';
    return {
        verdict,
        ledger: { path: independent.path, source: independent.source, productPath, samePath },
        survey,
        windowSeconds: BRAIN_WINDOW_SECONDS,
        findings,
    };
}

export function runCheckBrain(argv = []) {
    const opts = { json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        /*
         * The consumer root. `checkBrain` and `readWitnessedBrain` have always accepted it, but the
         * parser never produced it, so the only way to inspect another consumer was to `cd` there.
         * That mattered once a host started recording Brain evidence per consumer: the witnessed half of
         * this report is read from `<product-state>/attest/<pid>.json`, and the project id comes from
         * `<consumer>/harness.config.json`. Running from the wrong directory silently reported
         * `used: false` — a missing-argument bug wearing the costume of "no witness".
         *
         * Both `--consumer <path>` and `--consumer=<path>` are accepted; the latter is what a shell
         * completion or a copy-pasted agent command tends to produce.
         */
        else if (a === '--consumer') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('-')) throw new Error('--consumer requires a path');
            opts.consumer = value;
            i += 1;
        } else if (a.startsWith('--consumer=')) {
            const value = a.slice('--consumer='.length);
            if (!value) throw new Error('--consumer requires a path');
            opts.consumer = value;
        } else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    }
    const report = checkBrain(opts);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const bold = '\x1b[1m';
        const dim = '\x1b[2m';
        const reset = '\x1b[0m';
        const tag = report.verdict === 'pass' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(`\n${bold}Brain evidence${reset}  ${tag}`);
        console.log(`  ledger      ${report.ledger.path} ${dim}(${report.ledger.source})${reset}`);
        if (!report.ledger.samePath) console.log(`  product     ${report.ledger.productPath} ${dim}(DISAGREES)${reset}`);
        const s = report.survey;
        console.log(`  brain rows  ${s.brainRecords ?? 0}${s.newest ? ` ${dim}newest ${s.newest.at} (${s.ageSeconds}s)${reset}` : ''}`);
        if (report.witness?.used) {
            console.log(
                `  witness     ${report.witness.brainTier ?? '?'} ${dim}(${report.witness.ageSeconds}s, source ${report.witness.source})${reset}`,
            );
        }
        console.log(`  window      ${report.windowSeconds}s`);
        for (const f of report.findings) console.log(`\n  [${f.id}] ${f.detail}`);
        console.log('');
    }
    if (report.verdict !== 'pass') process.exitCode = 1;
    return report;
}
