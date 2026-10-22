/**
 * `harnessctl doctor dsh` — would the current DSH profile survive a tool call?
 *
 * Read-only, and deliberately not part of `verify host`: this answers a question about the **host's
 * own module graph**, not about the consumer's hooks. It exists because installing a plugin whose
 * peerDependencies touch `dsh-tools` gives the app a second copy of a package that uses `Symbol()`
 * for a cross-package contract, and every tool call then dies at `.prepare(...)` — see ATF-OPS-001.
 */
import { checkDshProfiles } from '../../harness-host-dsh/src/index.mjs';

export function runDoctorDsh(argv = []) {
    const opts = { profile: null, home: null, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--profile') opts.profile = argv[++i];
        else if (a === '--home') opts.home = argv[++i];
        else if (a === '--json') opts.json = true;
        else throw new Error(`unknown flag: ${a}`);
    }

    const report = checkDshProfiles({ home: opts.home || undefined, profile: opts.profile || undefined });
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const green = '\x1b[32mPASS\x1b[0m';
        const red = '\x1b[31mFAIL\x1b[0m';
        const yellow = '\x1b[33mWARN\x1b[0m';
        const dim = '\x1b[2m';
        const bold = '\x1b[1m';
        console.log(`\n${bold}DSH profile doctor${reset()}  ${dim}${report.home}${reset()}`);
        for (const row of report.profiles) {
            console.log(`\n  ${bold}${row.profile}${reset()}  ${row.verdict}`);
            for (const check of row.checks) {
                const tag = check.status === 'pass' ? green : check.status === 'warn' ? yellow : red;
                console.log(`    [${tag}] ${check.id}`);
                console.log(`           ${dim}${check.detail}${reset()}`);
            }
        }
        console.log(`\n  verdict: ${bold}${report.verdict}${reset()}\n`);
    }
    if (report.verdict === 'pathology-present') process.exitCode = 1;
    return report;
}

function reset() {
    return '\x1b[0m';
}
