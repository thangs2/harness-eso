/**
 * Host hook registry — one entry per hook the host pack can run.
 *
 * `onError` is the default posture when the hook cannot complete. It is deliberately not uniform:
 * a guard that cannot decide must block (fail closed), while a telemetry hook that cannot write a
 * trace line must not wedge the developer's turn. This replaces the previous behaviour where a
 * guard that could not resolve its engine either `exit 1`-ed (leaving the host to guess) or,
 * worse, silently emitted `allow`.
 *
 * The default is overridable per consumer via `guards.unavailable` in
 * `.harness/decision-policy.json` — see `errorPosture`. It is a policy key rather than a constant
 * because the right trade differs: a regulated repo wants `deny`, a repo mid-migration may accept
 * `warn` for a while instead of losing the ability to run anything.
 */
import { run as guardBrain } from './guard-brain-hook.mjs';
import { run as guardShell } from './guard-shell-hook.mjs';
import { run as gapTracker } from './gap-tracker-hook.mjs';
import { run as postToolHint } from './post-tool-hint.mjs';
import { run as preCompact } from './pre-compact-cost-hook.mjs';
import { run as preflight } from './preflight-hook.mjs';
import { run as route } from './route-hook.mjs';

/** @typedef {'deny' | 'allow'} ErrorPosture */

export const HOOKS = {
    // Guards: an undecidable write/shell/brain call must not proceed.
    'guard-shell': { run: guardShell, onError: 'deny', kind: 'guard' },
    'guard-brain': { run: guardBrain, onError: 'deny', kind: 'guard' },
    /*
     * There is deliberately no `guard-write` here.
     *
     * The ESO write gate belongs to the consumer, and the consumer already implements it:
     * `guard-write.py` reads the same `.eso-bundle-stamp.json` and applies it **only** to the paths it
     * guards (`PROTECTED_PREFIXES`, `locked-paths.txt`, secret files, secret material).
     *
     * A pack copy cannot replace it and does not complement it. It checked evidence but never the
     * path, so with sufficient evidence it allowed edits to `scripts/ci/`, `.env.local` and
     * `document/mu/be/00.law/` — the very files the consumer protects — while with insufficient
     * evidence it blocked ordinary edits to `src/`. Both directions are wrong, and wiring it would
     * have frozen all editing on any consumer whose evidence sits below threshold.
     *
     * It was unwired from both host profiles, then removed. See F26 / §18.
     */
    // Telemetry and context: failures must not wedge the turn.
    preflight: { run: preflight, onError: 'allow', kind: 'telemetry' },
    route: { run: route, onError: 'allow', kind: 'telemetry' },
    'gap-tracker': { run: gapTracker, onError: 'allow', kind: 'telemetry' },
    'post-tool-hint': { run: postToolHint, onError: 'allow', kind: 'telemetry' },
    'pre-compact': { run: preCompact, onError: 'allow', kind: 'telemetry' },
};

export const HOOK_NAMES = Object.keys(HOOKS);

/**
 * @param {string} name hook id from `--hook`
 * @param {string[]} [argv] remaining args, forwarded to the hook
 */
export async function runHook(name, argv = []) {
    const entry = HOOKS[name];
    if (!entry) throw new Error(`unknown hook: ${name}`);
    return entry.run(argv);
}

/**
 * @typedef {{ unavailable?: 'deny' | 'warn' }} GuardPolicy
 */

/**
 * Posture for a hook that failed, given the consumer's policy.
 *
 * `guards.unavailable` is the operator's statement about what to do when the guard cannot decide:
 *
 *   `'deny'` — block (the safe default for guards)
 *   `'warn'` — let the call through, but say so loudly in the turn's context
 *
 * Anything else falls back to the per-hook default. `warn` is never promoted to `deny` for a
 * telemetry hook: breaking a turn because a trace line failed would be a worse bug than the
 * missing line.
 *
 * @param {string} name
 * @param {GuardPolicy} [policy]
 * @returns {'deny' | 'warn' | 'allow'}
 */
export function errorPosture(name, policy) {
    const entry = HOOKS[name];
    if (!entry) return 'deny';
    if (entry.kind !== 'guard') return 'allow';
    const requested = policy?.unavailable;
    if (requested === 'warn' || requested === 'deny') return requested;
    return entry.onError;
}

/** True when this hook guards (as opposed to reporting). */
export function isGuard(name) {
    return HOOKS[name]?.kind === 'guard';
}

/** @deprecated kept for callers that only need the static default. */
export function defaultPosture(name) {
    return HOOKS[name]?.onError ?? 'deny';
}
