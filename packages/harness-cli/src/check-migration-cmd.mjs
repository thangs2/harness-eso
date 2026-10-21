/**
 * `harnessctl check migration <file...>` — report DDL that is not backward-compatible.
 *
 * Read-only and deterministic; the same file always produces the same findings.
 */
import fs from 'node:fs';
import { checkMigrationFiles } from '@mu/harness-eso-core';

export function checkMigrationPaths(paths) {
    return checkMigrationFiles(paths.map((file) => ({ file, content: fs.readFileSync(file, 'utf8') })));
}

export function runCheckMigration(argv = []) {
    const opts = { json: false };
    const paths = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (!a.startsWith('-')) paths.push(a);
        else throw new Error(`unknown flag: ${a}`);
    }
    if (!paths.length) throw new Error('usage: harnessctl check migration <file...> [--json]');

    const report = checkMigrationPaths(paths);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.findings.length) process.exitCode = 1;
        return report;
    }

    console.log(`\nmigration safety  ${report.files} file(s)`);
    if (!report.findings.length) {
        console.log('  no finding\n');
        return report;
    }
    for (const finding of report.findings) {
        console.log(`  ${finding.kind.padEnd(26)} ${finding.file}`);
        console.log(`    ${finding.detail}`);
        console.log(`    ${finding.statement}`);
    }
    console.log('');
    process.exitCode = 1;
    return report;
}
