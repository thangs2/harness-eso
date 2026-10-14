import path from 'node:path';
import { scanTokenDiet } from '@mu/harness-foundation/token-diet';
import { loadWorkspace } from '@mu/harness-foundation/workspace';

function resolveConsumer(opts, positional) {
    if (positional) return path.resolve(positional);
    if (opts.project) {
        const ws = loadWorkspace();
        const row = ws.projects.find((p) => p.id === opts.project);
        if (!row) {
            console.error(`token-diet: unknown project "${opts.project}" — harnessctl configure list`);
            process.exit(1);
        }
        return path.resolve(row.rootHost || row.root);
    }
    return process.cwd();
}

export function runTokenDiet(argv = []) {
    const opts = { project: null, json: false, tree: 'all' };
    let positional = null;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--project') opts.project = argv[++i];
        else if (a === '--tree') opts.tree = argv[++i];
        else if (a === '--json') opts.json = true;
        else if (!a.startsWith('-') && !positional) positional = a;
    }

    const consumerRoot = resolveConsumer(opts, positional);
    const report = scanTokenDiet(consumerRoot, { tree: opts.tree });

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.status === 'fail') process.exit(1);
        return;
    }

    // Human CLI format
    const cPass = '\x1b[32mPASS\x1b[0m';
    const cWarn = '\x1b[33mWARN\x1b[0m';
    const cFail = '\x1b[31mFAIL\x1b[0m';
    const cDim = '\x1b[2m';
    const cReset = '\x1b[0m';
    const cBold = '\x1b[1m';

    const statusTag = report.status === 'pass' ? cPass : (report.status === 'warn' ? cWarn : cFail);

    console.log(`\n${cBold}Harness Token-Diet Audit${cReset}`);
    console.log(`${cDim}Target:${cReset} ${consumerRoot}`);
    console.log(`${cDim}Scope:${cReset}  tree=${report.tree} (budget: <= ${report.budget.maxEagerRules} rules, <= ${report.budget.maxEagerTokens.toLocaleString()} tokens)`);
    console.log(`${cDim}Verdict:${cReset} [${statusTag}]\n`);

    for (const [treeName, treeReport] of Object.entries(report.trees)) {
        const treeTag = treeReport.status === 'pass' ? cPass : (treeReport.status === 'warn' ? cWarn : cFail);
        console.log(`${cBold}Tree: .${treeName}${cReset} [${treeTag}]`);

        const ruleBudgetTag = treeReport.assertions.ruleCount.pass ? cPass : cWarn;
        console.log(`  ${ruleBudgetTag}  Eager rules count: ${treeReport.summary.eagerRulesCount} / max ${treeReport.summary.budget.maxEagerRules}`);

        const tokenBudgetTag = treeReport.assertions.tokenBudget.pass ? cPass : cWarn;
        console.log(`  ${tokenBudgetTag}  Eager tokens estimate: ~${treeReport.summary.totalEagerTokens.toLocaleString()} / max ${treeReport.summary.budget.maxEagerTokens.toLocaleString()} tokens (${treeReport.summary.totalEagerBytes.toLocaleString()} bytes)`);

        const integrityTag = treeReport.assertions.frontmatterIntegrity.pass ? cPass : cFail;
        console.log(`  ${integrityTag}  No alwaysApply + globs conflict (${treeReport.conflicts.length} conflict(s))`);

        const lazyGlobsTag = treeReport.assertions.lazyGlobs.pass ? cPass : cFail;
        console.log(`  ${lazyGlobsTag}  Lazy rules declare globs (${treeReport.missingGlobs.length} missing)`);

        console.log(`  ${cDim}Eager Rules (${treeReport.eagerRules.length}):${cReset}`);
        if (treeReport.eagerRules.length === 0) {
            console.log(`    (none)`);
        } else {
            for (const r of treeReport.eagerRules) {
                console.log(`    - ${r.path} [~${r.tokens} tokens, ${r.bytes}B]`);
            }
        }

        console.log(`  ${cDim}Harness Root Files (${treeReport.harnessFiles.length}):${cReset}`);
        if (treeReport.harnessFiles.length === 0) {
            console.log(`    (none)`);
        } else {
            for (const h of treeReport.harnessFiles) {
                console.log(`    - ${h.path} [~${h.tokens} tokens, ${h.bytes}B]`);
            }
        }

        console.log(`  ${cDim}Lazy Rules (${treeReport.lazyRules.length}):${cReset}`);
        console.log(`    ${treeReport.lazyRules.length} rules dynamically loaded on-demand via globs.`);

        if (treeReport.conflicts.length > 0) {
            console.log(`  ${cFail} Conflicts:${cReset}`);
            for (const c of treeReport.conflicts) {
                console.log(`    - ${c.file}: ${c.reason}`);
            }
        }

        if (treeReport.missingGlobs.length > 0) {
            console.log(`  ${cFail} Missing globs:${cReset}`);
            for (const m of treeReport.missingGlobs) {
                console.log(`    - ${m.file}: ${m.reason}`);
            }
        }
        console.log();
    }

    if (report.status === 'fail') {
        process.exit(1);
    }
}
