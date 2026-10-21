/**
 * `harnessctl capability probe` — render the capability fabric for one consumer (RFC 18 M3).
 *
 * The point is not a pretty table. It answers, before a run, the question a trace answers after one:
 * *which provider will this consumer use for each kind, and why was the alternative skipped?* That is
 * what makes `prefer: ["native"]` reviewable instead of magical.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDecisionPolicy, loadWorkspace } from '@mu/harness-foundation';
import { createSourceRegistry, probeCapabilities } from '@mu/harness-eso-core';

function resolveConsumer(opts, positional) {
    if (positional) return path.resolve(positional);
    if (opts.project) {
        const ws = loadWorkspace();
        const row = ws.projects.find((p) => p.id === opts.project);
        if (!row) throw new Error(`unknown project "${opts.project}" — harnessctl configure list`);
        return path.resolve(row.rootHost || row.root);
    }
    return process.cwd();
}

/**
 * Pure part of the command: resolve the policy, build the registry, probe it.
 *
 * @param {string} root consumer root
 * @param {{ extraProviders?: object[] }} [options] providers a host shim would register
 */
export function buildCapabilityReport(root, options = {}) {
    const loaded = loadDecisionPolicy({ root });
    const registry = createSourceRegistry(loaded.policy, options.extraProviders ?? []);
    return {
        root,
        policyPath: loaded.path,
        policyFromFile: loaded.fromFile,
        kinds: probeCapabilities(registry),
    };
}

async function loadProviders(specs) {
    const providers = [];
    for (const spec of specs) {
        const mod = await import(pathToFileURL(path.resolve(spec)).href);
        const exported = mod.providers ?? mod.default ?? [];
        if (!Array.isArray(exported)) {
            throw new Error(`${spec}: expected an array export "providers" (or a default array)`);
        }
        providers.push(...exported);
    }
    return providers;
}

export async function runCapabilityProbe(argv = []) {
    const opts = { project: null, json: false, providers: [] };
    let positional = null;

    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--project') opts.project = argv[++i];
        else if (a === '--provider') opts.providers.push(argv[++i]);
        else if (a === '--json') opts.json = true;
        else if (!a.startsWith('-') && !positional) positional = a;
        else throw new Error(`unknown flag: ${a}`);
    }

    const root = resolveConsumer(opts, positional);
    const report = buildCapabilityReport(root, { extraProviders: await loadProviders(opts.providers) });

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return report;
    }

    const dim = '\x1b[2m';
    const bold = '\x1b[1m';
    const reset = '\x1b[0m';
    console.log(`\n${bold}Harness capability probe${reset}`);
    console.log(`${dim}Consumer:${reset} ${report.root}`);
    console.log(`${dim}Policy:${reset}   ${report.policyPath || '(defaults)'}${report.policyFromFile ? '' : ' [not found — defaults]'}\n`);

    for (const row of report.kinds) {
        const selected = row.selected ? `${row.selected.id} (${row.selected.capability}${row.selected.ceiling !== null ? `, ceiling ${row.selected.ceiling}` : ''})` : '—';
        console.log(`${bold}${row.kind.padEnd(9)}${reset} ${selected}   ${dim}reason=${row.reason}${reset}`);
        for (const candidate of row.candidates) {
            const mark = candidate.selected ? '*' : ' ';
            const ceiling = candidate.ceiling !== null ? ` ceiling=${candidate.ceiling}` : '';
            console.log(`  ${mark} ${candidate.id} (${candidate.capability}${ceiling})`);
        }
    }
    console.log('');
    return report;
}
