/**
 * `harnessctl check contract <before.json> <after.json>` — report what a change breaks for callers.
 *
 * Deterministic and read-only: two OpenAPI documents in, a list of breaking findings out. Nothing is
 * inferred from the repository layout, so the same pair of files always produces the same answer.
 */
import fs from 'node:fs';
import { diffContracts } from '@mu/harness-eso-core';

export function compareContractFiles(beforePath, afterPath, options = {}) {
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
        before: beforePath,
        after: afterPath,
        direction: options.direction ?? 'response',
        ...diffContracts(read(beforePath), read(afterPath), { direction: options.direction }),
    };
}

export function runCheckContract(argv = []) {
    const opts = { direction: 'response', json: false };
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--direction') opts.direction = argv[++i];
        else if (a === '--json') opts.json = true;
        else if (!a.startsWith('-')) positional.push(a);
        else throw new Error(`unknown flag: ${a}`);
    }
    if (positional.length !== 2) {
        throw new Error('usage: harnessctl check contract <before.json> <after.json> [--direction response|request] [--json]');
    }

    const report = compareContractFiles(positional[0], positional[1], { direction: opts.direction });
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.breaking.length) process.exitCode = 1;
        return report;
    }

    console.log(`\ncontract diff  ${report.before} -> ${report.after}  (${report.direction}, ${report.checked} operation(s))`);
    if (!report.breaking.length) console.log('  no breaking change\n');
    else {
        for (const finding of report.breaking) console.log(`  BREAKING  ${finding.kind.padEnd(16)} ${finding.path} — ${finding.detail}`);
        console.log('');
        process.exitCode = 1;
    }
    return report;
}
