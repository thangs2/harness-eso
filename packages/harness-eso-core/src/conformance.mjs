/**
 * Host conformance H0–H4 (RFC 18 §3.6).
 *
 * A product that claims "supported host" without evidence is guessing. Each tier is a read-only
 * probe over the consumer's own files, so the answer is reproducible and cannot be improved by
 * restarting something:
 *
 *   H0  a host hook config calls the harness pack
 *   H1  the pack is present and at least one guard is wired
 *   H2  a preflight verdict exists (level + timestamp) and postdates the installed pack
 *   H3  the route trace has evidence (≥1 event)
 *   H4  a native provider is bound (only when the caller supplies a capability probe)
 *   H5  the gate is outside the declared editable surface and always-on stays in budget (B2)
 *
 * Tiers are consecutive: `tierReached` stops at the first failure, because H3 evidence from a run
 * whose hooks never fired is not the same claim.
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkHarnessSurface, readHarnessSurface } from './surface-check.mjs';
import { checkGuardFreshness } from './guard-freshness.mjs';

export const CONFORMANCE_TIERS = [
    { id: 'H0', title: 'host hooks call the harness pack' },
    { id: 'H1', title: 'host pack present and a guard is wired' },
    { id: 'H2', title: 'preflight produced a verdict' },
    { id: 'H3', title: 'route trace contains evidence' },
    { id: 'H4', title: 'a native provider is bound' },
    { id: 'H5', title: 'the gate is outside the editable surface' },
];

const TREES = [
    { id: 'cursor', hooks: '.cursor/hooks.json', session: '.cursor/session' },
    { id: 'agents', hooks: '.agents/hooks.json', session: '.agents/session' },
    { id: 'claude', hooks: '.claude/settings.json', session: '.claude/session' },
    { id: 'codex', hooks: '.codex/hooks.json', session: '.codex/session' },
];

function readJson(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function wiredTrees(root) {
    const out = [];
    for (const tree of TREES) {
        const file = path.join(root, tree.hooks);
        if (!fs.existsSync(file)) continue;
        const parsed = readJson(file);
        if (!parsed.ok) {
            out.push({ tree, file, wired: false, error: `invalid JSON: ${parsed.error}` });
            continue;
        }
        const serialized = JSON.stringify(parsed.value);
        out.push({
            tree,
            file,
            wired: serialized.includes('harness-hook.mjs'),
            guards: (serialized.match(/guard-shell|guard-brain|guard-write/g) ?? []).length > 0,
        });
    }
    return out;
}

function sessionArtifact(root, name) {
    for (const tree of TREES) {
        const file = path.join(root, tree.session, name);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

/*
 * H2 has the same shape of defect H1 had (G-17): it accepted "a verdict exists", never "a verdict
 * from the code now installed". Atrievefin, 2026-10-23: the pack was refreshed at 14:29 UTC and
 * H2 still passed on an `insufficient` verdict written at 11:21 UTC by the previous pack — ten
 * hours and a guard rewrite earlier. A probe that cannot go out of date reports the past as
 * present, which is worse than reporting nothing.
 *
 * The comparison is deliberately coarse. Two independent producers stamp `at` (the hook with
 * millisecond ISO, the projection trimmed to whole seconds), so the pack's mtime carries
 * `mtimeSkewMs` of tolerance to avoid turning rounding into a failure. A file modified after a
 * verdict was written is exactly the case that must not pass.
 */
const MTIME_SKEW_MS = 1000;

function checkVerdictAge(verdictAt, packPath) {
    const at = Date.parse(verdictAt);
    if (!Number.isFinite(at)) return { fresh: false, reason: `\`at\` is not a parseable time: ${verdictAt}` };
    if (!fs.existsSync(packPath)) return { fresh: true, packMtime: null };
    const packMtime = fs.statSync(packPath).mtimeMs;
    if (at + MTIME_SKEW_MS < packMtime) {
        return {
            fresh: false,
            packMtime,
            reason: `verdict predates the installed pack (${new Date(at).toISOString()} < ${new Date(
                packMtime,
            ).toISOString()}) — the run that produced it used different code`,
        };
    }
    return { fresh: true, packMtime };
}

function result(id, status, detail) {
    const meta = CONFORMANCE_TIERS.find((t) => t.id === id);
    return { id, title: meta?.title ?? id, status, detail };
}

/**
 * @param {string} root consumer root
 * @param {{
 *   probe?: ReturnType<import('./capability-probe.mjs').probeCapabilities>,
 *   requireNative?: boolean,
 *   surface?: object|null,
 * }} [options] `surface` overrides `harness.config.json#harnessSurface` (tests, probes)
 */
export function runHostConformance(root, options = {}) {
    const trees = wiredTrees(root);
    const wired = trees.filter((t) => t.wired);
    const packPath = path.join(root, '.harness', 'host-pack', 'harness-hook.mjs');
    const hasPack = fs.existsSync(packPath);

    const h0 =
        wired.length > 0
            ? result('H0', 'pass', `${wired.map((t) => t.tree.id).join(', ')} hook config references harness-hook.mjs`)
            : result(
                  'H0',
                  trees.length ? 'fail' : 'fail',
                  trees.length
                      ? `hook config found but no harness-hook.mjs reference: ${trees.map((t) => t.tree.id).join(', ')}`
                      : 'no .cursor/hooks.json, .agents/hooks.json or .claude/settings.json',
              );

    const guardWired = wired.some((t) => t.guards);
    /*
     * H1 asks a second question: *is it this product's guard* (G-17).
     *
     * It used to stop at "a file named guard-write.py is referenced by a hook config", which
     * atrievefin satisfied on 2026-10-23 while running a copy predating the deny-message fix — a
     * `./provision.sh --force` and a PASS later, the operator still saw the old gate. A wired but
     * stale guard is not a passing host: the consumer is running a different product than the one
     * that just deployed it, and no other tier reports that.
     */
    const freshness = checkGuardFreshness(root);
    const h1 =
        hasPack && guardWired && freshness.status !== 'stale'
            ? result(
                  'H1',
                  'pass',
                  `.harness/host-pack present; guard wired in ${wired.filter((t) => t.guards).map((t) => t.tree.id).join(', ')}${
                      freshness.status === 'customised' ? `; ${freshness.detail}` : ''
                  }`,
              )
            : result(
                  'H1',
                  'fail',
                  hasPack
                      ? guardWired
                          ? `guard is ${freshness.status}: ${freshness.detail}`
                          : 'no guard command in any wired hook config'
                      : 'missing .harness/host-pack/harness-hook.mjs',
              );

    const preflightFile = sessionArtifact(root, '.eso-preflight.json');
    let h2 = result('H2', 'fail', 'no .eso-preflight.json in any session directory');
    if (preflightFile) {
        const parsed = readJson(preflightFile);
        if (!parsed.ok) h2 = result('H2', 'fail', `preflight file is not JSON: ${parsed.error}`);
        else if (typeof parsed.value?.level !== 'string' || !parsed.value?.at) {
            h2 = result('H2', 'fail', 'preflight file has no level/at — it never produced a verdict');
        } else {
            const age = checkVerdictAge(parsed.value.at, packPath);
            h2 = age.fresh
                ? result('H2', 'pass', `${path.relative(root, preflightFile)}: ${parsed.value.level} at ${parsed.value.at}`)
                : result('H2', 'fail', `${path.relative(root, preflightFile)}: ${age.reason}; run one agent turn, then re-verify`);
        }
    }

    const traceFile = sessionArtifact(root, 'route-trace.jsonl');
    let h3 = result('H3', 'fail', 'no route-trace.jsonl in any session directory');
    if (traceFile) {
        const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter((line) => line.trim());
        h3 = lines.length
            ? result('H3', 'pass', `${path.relative(root, traceFile)}: ${lines.length} event(s)`)
            : result('H3', 'fail', `${path.relative(root, traceFile)} is empty`);
    }

    /*
     * H4 is optional by construction: a host with no shim cannot bind a native provider, and calling
     * that a failure would mark every Cursor consumer non-conformant. `requireNative` is how a
     * DSH/Paseo run opts into the strict reading.
     */
    let h4 = result('H4', 'skip', 'no host capability probe supplied');
    if (Array.isArray(options.probe)) {
        const natives = options.probe.filter((row) => row?.selected?.capability === 'native');
        if (natives.length) h4 = result('H4', 'pass', `native provider bound for ${natives.map((n) => n.kind).join(', ')}`);
        else if (options.requireNative) h4 = result('H4', 'fail', 'no kind resolves to a native provider');
        else h4 = result('H4', 'skip', 'no native provider — H4 requires a host shim (pass --require-native to enforce)');
    }

    /*
     * H5 is a different axis from H0–H4: those say the host is wired, this says the wiring cannot be
     * edited away. It is opt-in by declaration — a consumer with no `harnessSurface` in
     * `harness.config.json` reports `skip`, so no existing consumer changes its answer.
     */
    const surface = checkHarnessSurface(root, options.surface ?? readHarnessSurface(root));
    const h5 = result('H5', surface.status, surface.detail);

    const tiers = [h0, h1, h2, h3, h4, h5];
    let tierReached = '-';
    for (const tier of tiers) {
        if (tier.status !== 'pass') break;
        tierReached = tier.id;
    }

    return {
        standardId: 'host-conformance',
        standardVersion: 1,
        root,
        tiers,
        tierReached,
        surface,
        guards: freshness,
        // A declared surface whose gate is editable is not a working host, whatever H0–H3 say.
        ok:
            h0.status === 'pass' &&
            h1.status === 'pass' &&
            h2.status === 'pass' &&
            h3.status === 'pass' &&
            surface.status !== 'fail',
    };
}
