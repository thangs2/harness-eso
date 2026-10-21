/**
 * `harnessctl verify host` — run the H0–H4 conformance tiers (RFC 18 §3.6).
 *
 * Read-only: it inspects the consumer's hook configs, host pack, session artifacts and (optionally)
 * the capability probe. Nothing is written, so the answer is safe to ask for on every run.
 */
import path from 'node:path';
import { loadWorkspace } from '@mu/harness-foundation';
import { runHostConformance } from '@mu/harness-eso-core';
import { buildCapabilityReport } from './capability-probe-cmd.mjs';

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

export function buildHostConformance(root, options = {}) {
    const probe = buildCapabilityReport(root, { recipe: options.recipe }).kinds;
    return runHostConformance(root, { probe, requireNative: options.requireNative === true });
}

export function runVerifyHost(argv = []) {
    const opts = { project: null, json: false, recipe: null, requireNative: false };
    let positional = null;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--project') opts.project = argv[++i];
        else if (a === '--recipe') opts.recipe = argv[++i];
        else if (a === '--require-native') opts.requireNative = true;
        else if (a === '--json') opts.json = true;
        else if (!a.startsWith('-') && !positional) positional = a;
        else throw new Error(`unknown flag: ${a}`);
    }

    const root = resolveConsumer(opts, positional);
    const report = buildHostConformance(root, { recipe: opts.recipe, requireNative: opts.requireNative });

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.ok) process.exitCode = 1;
        return report;
    }

    const green = '\x1b[32mPASS\x1b[0m';
    const red = '\x1b[31mFAIL\x1b[0m';
    const dim = '\x1b[2m';
    const bold = '\x1b[1m';
    const reset = '\x1b[0m';

    console.log(`\n${bold}Host conformance${reset}  ${dim}${report.root}${reset}`);
    for (const tier of report.tiers) {
        const tag = tier.status === 'pass' ? green : tier.status === 'skip' ? '\x1b[33mSKIP\x1b[0m' : red;
        console.log(`  [${tag}] ${tier.id}  ${tier.title}`);
        console.log(`         ${dim}${tier.detail}${reset}`);
        // A surface usually has more than one problem; the tier detail carries only the first.
        if (tier.id === 'H5' && Array.isArray(report.surface?.violations) && report.surface.violations.length > 1) {
            for (const violation of report.surface.violations.slice(1)) {
                console.log(`         ${dim}- ${violation.surface}: ${violation.detail}${reset}`);
            }
        }
    }
    console.log(`\n  tier reached: ${bold}${report.tierReached}${reset}\n`);
    if (!report.ok) process.exitCode = 1;
    return report;
}
