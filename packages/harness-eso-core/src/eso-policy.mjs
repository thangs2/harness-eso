import { loadDecisionPolicy } from '@mu/harness-foundation/pure';

export const ESO_MODES = ['observe', 'hint', 'fail_closed'];

/**
 * The only values `eso.enforceWrites` may take.
 *
 * `off` disables the ESO write gate; `fail_closed` enforces it. There is deliberately no third
 * value: `observe` reads like a valid setting (it IS a valid `eso.mode`) but it never was one here,
 * and treating it as one silently was the defect recorded as F24.
 */
export const ENFORCE_WRITES_VALUES = ['fail_closed', 'off'];

export const DEFAULT_ESO_POLICY = {
    enabled: true,
    mode: 'hint',
    enforceWrites: 'fail_closed',
    thresholds: { T_low: 0.45, T_high: 0.72 },
    preflight: { enabled: true, maxMs: 8000 },
    memoryFetch: true,
    cognition: { insufficientPromptGate: 'consent' },
    sources: {
        law: { adapter: 'docgraph-cli', enabled: true },
        code: { adapter: 'codegraph-cli', enabled: true },
        memory: { adapter: 'noop-memory', enabled: false },
    },
};

/** Values already reported, so a hot path warns once instead of on every turn. */
const warnedEnforceValues = new Set();
const warnedCheckValues = new Set();

function warnAboutCheck(key, message) {
    if (warnedCheckValues.has(key)) return;
    warnedCheckValues.add(key);
    // stderr, for the same reason as enforceWrites: stdout is the hook verdict.
    process.stderr.write(`harness: ${message}\n`);
}

const pathOrObject = (value) =>
    (typeof value === 'string' && value.trim().length > 0) || (value !== null && typeof value === 'object');

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);

/**
 * Normalise `eso.checks` — the checks a consumer declares so it does not have to pass them to a host
 * shim by hand.
 *
 * Invalid entries are **dropped with one warning each**, never thrown: this is read on the preflight
 * path, and a typo in a config must not turn into an exception inside a hook. Dropping is the safe
 * direction only because `checks` is opt-in — a declared check that is dropped means "no blocker",
 * which is why the warning exists.
 *
 * @param {unknown} raw
 * @returns {{ contract?: object, project?: object, migration?: object } | null}
 */
export function normaliseChecks(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    if (raw.contract !== undefined) {
        const before = raw.contract?.before;
        const after = raw.contract?.after;
        if (pathOrObject(before) && pathOrObject(after)) {
            out.contract = {
                before,
                after,
                direction: raw.contract?.direction === 'request' ? 'request' : 'response',
            };
        } else {
            warnAboutCheck(
                'contract',
                'eso.checks.contract needs before and after (a path or a parsed object) — ignored',
            );
        }
    }

    if (raw.project !== undefined) {
        const files = stringList(raw.project?.files);
        const tables = stringList(raw.project?.tables);
        if (files.length && tables.length) out.project = { files, tables };
        else {
            warnAboutCheck(
                'project',
                'eso.checks.project needs both files and tables (an isolation check without tables checks nothing) — ignored',
            );
        }
    }

    if (raw.migration !== undefined) {
        const files = stringList(raw.migration?.files);
        if (files.length) out.migration = { files };
        else warnAboutCheck('migration', 'eso.checks.migration needs files — ignored');
    }

    return Object.keys(out).length ? out : null;
}

/**
 * Resolve `eso.enforceWrites` to a definite posture.
 *
 * The old rule was `raw.enforceWrites === 'fail_closed' || raw.enforceWrites === 'off' ? raw : …`,
 * which — because the fallback and the default are both `fail_closed` — collapsed to
 * **"`off`, or else enforce"**. The `mode === 'fail_closed'` branch in the middle was dead code: both
 * of its arms resolved to the same value. Two consequences, both silent:
 *
 *   - an unrecognised value such as `observe` looked accepted and was coerced to the *strictest*
 *     posture, so writing the most permissive setting produced the most restrictive one.
 *   - `gate.mjs` re-derived the same answer with a *different* fallback (`'off'`), so the two files
 *     disagreed for any input that was not already normalised. It stayed hidden only because
 *     `orchestrateTurn` always passes an already-resolved policy.
 *
 * Now there is one function and one valid set, and an unrecognised value says so out loud. The
 * posture is deliberately unchanged: an ambiguous config still resolves to the conservative default
 * rather than quietly loosening a guard. What changes is that it is no longer silent, and no longer
 * duplicated.
 *
 * @param {{ enforceWrites?: unknown, mode?: string }} rawEso
 * @returns {'fail_closed' | 'off'}
 */
export function resolveEnforceWrites(rawEso = {}) {
    const raw = rawEso?.enforceWrites;

    if (ENFORCE_WRITES_VALUES.includes(raw)) return raw;

    if (raw !== undefined && raw !== null && raw !== '') {
        const key = String(raw);
        if (!warnedEnforceValues.has(key)) {
            warnedEnforceValues.add(key);
            // stderr, not stdout: the host reads stdout as the hook verdict, and a diagnostic must
            // never be mistaken for one.
            process.stderr.write(
                `harness: eso.enforceWrites = ${JSON.stringify(raw)} is not valid ` +
                    `(use ${ENFORCE_WRITES_VALUES.map((v) => `"${v}"`).join(' or ')}) — ` +
                    'resolving to "fail_closed". ' +
                    (key === 'observe' ? 'If you meant "do not enforce", write "off".' : '') +
                    '\n',
            );
        }
    }

    return DEFAULT_ESO_POLICY.enforceWrites;
}

/**
 * @param {object} policy — full decision policy
 */
export function resolveEsoPolicy(policy) {
    const raw = policy?.eso || {};
    const mode = ESO_MODES.includes(raw.mode) ? raw.mode : DEFAULT_ESO_POLICY.mode;
    const enforceWrites = resolveEnforceWrites(raw);
    const preflightRaw = raw.preflight || {};
    const sources = { ...DEFAULT_ESO_POLICY.sources, ...(raw.sources || {}) };
    return {
        enabled: raw.enabled !== false,
        mode,
        enforceWrites,
        thresholds: {
            T_low: Number(raw.thresholds?.T_low ?? DEFAULT_ESO_POLICY.thresholds.T_low),
            T_high: Number(raw.thresholds?.T_high ?? DEFAULT_ESO_POLICY.thresholds.T_high),
        },
        preflight: {
            enabled: preflightRaw.enabled !== false,
            maxMs: Number(preflightRaw.maxMs ?? DEFAULT_ESO_POLICY.preflight.maxMs) || 8000,
            jevOnPartial: preflightRaw.jevOnPartial === true,
        },
        memoryFetch: raw.memoryFetch !== false,
        checks: normaliseChecks(raw.checks),
        cognition: {
            insufficientPromptGate:
                raw.cognition?.insufficientPromptGate ??
                DEFAULT_ESO_POLICY.cognition.insufficientPromptGate,
        },
        sources,
    };
}

/**
 * @param {{ root?: string, decisionPolicyPath?: string }} [cfg]
 */
export function loadEsoPolicy(cfg) {
    const loaded = loadDecisionPolicy(cfg);
    let policy = loaded.policy;
    const esoMode = process.env.ESO_MODE;
    if (esoMode && ESO_MODES.includes(esoMode)) {
        policy = { ...policy, eso: { ...policy.eso, mode: esoMode } };
    }
    return { policy, eso: resolveEsoPolicy(policy), path: loaded.path };
}
