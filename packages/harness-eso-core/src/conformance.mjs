/**
 * Host conformance H0–H4 (RFC 18 §3.6).
 *
 * A product that claims "supported host" without evidence is guessing. Each tier is a read-only
 * probe over the consumer's own files, so the answer is reproducible and cannot be improved by
 * restarting something:
 *
 *   H0  a host hook config calls the harness pack
 *   H1  the pack is present and at least one guard is wired
 *   H2  a preflight verdict exists (level + timestamp)
 *   H3  the route trace has evidence (≥1 event)
 *   H4  a native provider is bound (only when the caller supplies a capability probe)
 *
 * Tiers are consecutive: `tierReached` stops at the first failure, because H3 evidence from a run
 * whose hooks never fired is not the same claim.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONFORMANCE_TIERS = [
    { id: 'H0', title: 'host hooks call the harness pack' },
    { id: 'H1', title: 'host pack present and a guard is wired' },
    { id: 'H2', title: 'preflight produced a verdict' },
    { id: 'H3', title: 'route trace contains evidence' },
    { id: 'H4', title: 'a native provider is bound' },
];

const TREES = [
    { id: 'cursor', hooks: '.cursor/hooks.json', session: '.cursor/session' },
    { id: 'agents', hooks: '.agents/hooks.json', session: '.agents/session' },
    { id: 'claude', hooks: '.claude/settings.json', session: '.claude/session' },
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

function result(id, status, detail) {
    const meta = CONFORMANCE_TIERS.find((t) => t.id === id);
    return { id, title: meta?.title ?? id, status, detail };
}

/**
 * @param {string} root consumer root
 * @param {{ probe?: ReturnType<import('./capability-probe.mjs').probeCapabilities> }} [options]
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
    const h1 =
        hasPack && guardWired
            ? result('H1', 'pass', `.harness/host-pack present; guard wired in ${wired.filter((t) => t.guards).map((t) => t.tree.id).join(', ')}`)
            : result('H1', 'fail', !hasPack ? 'missing .harness/host-pack/harness-hook.mjs' : 'no guard command in any wired hook config');

    const preflightFile = sessionArtifact(root, '.eso-preflight.json');
    let h2 = result('H2', 'fail', 'no .eso-preflight.json in any session directory');
    if (preflightFile) {
        const parsed = readJson(preflightFile);
        if (!parsed.ok) h2 = result('H2', 'fail', `preflight file is not JSON: ${parsed.error}`);
        else if (typeof parsed.value?.level !== 'string' || !parsed.value?.at) {
            h2 = result('H2', 'fail', 'preflight file has no level/at — it never produced a verdict');
        } else {
            h2 = result('H2', 'pass', `${path.relative(root, preflightFile)}: ${parsed.value.level} at ${parsed.value.at}`);
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

    const tiers = [h0, h1, h2, h3, h4];
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
        ok: h0.status === 'pass' && h1.status === 'pass' && h2.status === 'pass' && h3.status === 'pass',
    };
}
