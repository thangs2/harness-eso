/**
 * `harnessctl check isolation <file...> --tables orders,invoices` — flag SQL that touches a declared
 * project-scoped table without naming the project.
 *
 * The table list is an argument on purpose: this command must not guess which tables are scoped.
 */
import fs from 'node:fs';
import { checkIsolationFiles } from '@mu/harness-eso-core';

export function checkIsolationPaths(paths, scopedTables) {
    return checkIsolationFiles(
        paths.map((file) => ({ file, content: fs.readFileSync(file, 'utf8') })),
        { scopedTables },
    );
}

export function runCheckIsolation(argv = []) {
    const opts = { tables: [], json: false };
    const paths = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--tables') opts.tables = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--json') opts.json = true;
        else if (!a.startsWith('-')) paths.push(a);
        else throw new Error(`unknown flag: ${a}`);
    }
    if (!paths.length || !opts.tables.length) {
        throw new Error('usage: harnessctl check isolation <file...> --tables <table,table> [--json]');
    }

    const report = checkIsolationPaths(paths, opts.tables);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.findings.length) process.exitCode = 1;
        return report;
    }

    console.log(`\nisolation  ${report.files} file(s), tables: ${opts.tables.join(', ')}`);
    if (!report.findings.length) {
        console.log('  no finding\n');
        return report;
    }
    for (const finding of report.findings) {
        console.log(`  ${finding.kind.padEnd(22)} ${finding.file}  ${finding.table}`);
        console.log(`    ${finding.detail}`);
        console.log(`    ${finding.statement}`);
    }
    console.log('');
    process.exitCode = 1;
    return report;
}
