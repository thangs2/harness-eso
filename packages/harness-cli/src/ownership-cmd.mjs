#!/usr/bin/env node
/**
 * `harnessctl ownership explain "<policy.path>"` — who owns one key, and where that was decided.
 *
 * ## Why this exists next to `init report`
 *
 * `init report` answers "which keys belong to whom" for a whole consumer, by diffing the provision plan
 * against the file. That answer is *situational*: a key the plan happens to define today is listed as
 * product-written, even when the runbook declares it the consumer's (`paths.locked` is the standing
 * example — the shipped profile carries a default list, the runbook calls that list the consumer's
 * Source of Truth). Report says what a provision does; this says **what the product intends**, and the
 * two are allowed to differ.
 *
 * ## Why the table is code rather than prose
 *
 * An ownership claim that lives only in a document is the exact defect class this repo keeps hitting
 * (G-16: "the operator guide contradicts the shipped guard"). The table below is therefore closed: every
 * entry must name a `documents/` path that exists, and `qc/ownership-claims.test.mjs` enforces that plus
 * coverage of every policy subtree the shipped profile defines. Adding a subtree to `profiles/
 * generic-eso.json` without deciding its owner fails the test — silence is not an owner.
 */

/**
 * One row per policy subtree. `owner` is the **intended** owner, `writtenBy` is which half of provisioning
 * writes a value today, and `declaredIn` is the document that says so — a claim without a citation is
 * how the boundary drifted the last time.
 */
export const OWNERSHIP_CLAIMS = [
    {
        path: 'version',
        owner: 'product',
        writtenBy: 'provision',
        question: 'which schema version does this file follow?',
        declaredIn: 'profiles/generic-eso.json',
    },
    {
        path: 'profile',
        owner: 'product',
        writtenBy: 'provision',
        question: 'which shipped baseline was this consumer created from?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'eso',
        owner: 'product',
        writtenBy: 'provision (merged)',
        question: 'is the engine on, and at which posture (mode, enforceWrites, sources)?',
        declaredIn: 'documents/05.development/10.feature-and-classification-map.md',
    },
    {
        path: 'paths',
        owner: 'consumer',
        writtenBy: 'provision seeds a default list; the consumer owns the values',
        question: 'which paths are locked / gated / ask / sot?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'sot',
        owner: 'consumer',
        writtenBy: 'nothing — survives every provision',
        question: 'what does this project consider its source of truth?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'jev',
        owner: 'consumer',
        writtenBy: 'provision seeds off; enabling is the consumer’s decision',
        question: 'does this consumer have a Jev (L2) instance, and in which mode?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'fallback',
        owner: 'consumer',
        writtenBy: 'provision seeds the baseline; L3 flash is opt-in',
        question: 'what happens when a higher tier is unreachable?',
        declaredIn: 'documents/02.runtime/05.decision-facade.md',
    },
    {
        path: 'on_ambiguous',
        owner: 'consumer',
        writtenBy: 'provision seeds a default',
        question: 'on an ambiguous verdict, ask a human or proceed?',
        declaredIn: 'documents/02.runtime/05.decision-facade.md',
    },
    {
        path: 'ledger',
        owner: 'product',
        writtenBy: 'provision',
        question: 'is the evidence ledger recording?',
        declaredIn: 'documents/03.state-and-contracts/02.data-model.md',
    },
    {
        path: 'tokenDiet',
        owner: 'product',
        writtenBy: 'provision',
        question: 'what is the per-turn reply budget for eager rules?',
        declaredIn: 'documents/05.development/10.feature-and-classification-map.md',
    },
    {
        path: 'harnessConsole',
        owner: 'consumer',
        writtenBy: 'provision seeds the adapter from the project document',
        question: 'which Brain adapter does the Console call, with which key?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'guard-write.py',
        owner: 'product',
        writtenBy: 'provision copies it once (`create-if-missing`); drift is reported by guard-freshness',
        question: 'is the consumer running this build’s gate?',
        declaredIn: 'documents/03.state-and-contracts/04.host-pack-contract.md',
    },
    {
        path: '.cursor/rules/*',
        owner: 'consumer',
        writtenBy: 'nothing after bootstrap — operator-owned',
        question: 'what rules does the agent see in this project?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
    {
        path: 'SDLC/',
        owner: 'consumer',
        writtenBy: 'nothing — the product never writes domain documents',
        question: 'what is the project’s WBS / spec tree?',
        declaredIn: 'documents/02.runtime/08.provisioning-consumers.md',
    },
];

/** The row for an exact path, or for the nearest ancestor subtree (`paths.locked` → `paths`). */
export function explainOwnership(dotted) {
    const key = String(dotted || '').trim();
    if (!key) return null;
    const exact = OWNERSHIP_CLAIMS.find((c) => c.path === key);
    if (exact) return { ...exact, matched: exact.path };
    const parts = key.split('.');
    for (let i = parts.length - 1; i >= 1; i -= 1) {
        const prefix = parts.slice(0, i).join('.');
        const row = OWNERSHIP_CLAIMS.find((c) => c.path === prefix);
        if (row) return { ...row, matched: prefix };
    }
    return null;
}

export function runOwnershipCmd(argv) {
    const dotted = argv.filter((a) => !a.startsWith('-')).join(' ');
    if (!dotted) {
        console.error('usage: harnessctl ownership explain <policy.path>   e.g. paths.locked, eso.enforceWrites');
        console.error('       keys are the top-level subtrees of .harness/decision-policy.json');
        console.error(`       known: ${OWNERSHIP_CLAIMS.map((c) => c.path).join(', ')}`);
        process.exit(2);
    }
    const row = explainOwnership(dotted);
    if (!row) {
        // Naming the miss is the point: `init report` already lists what the consumer's file contains, so
        // an unowned key here means the product has no claim on it — not that the key is an error.
        console.log(`${dotted}  → no product claim`);
        console.log('  This key is not declared in OWNERSHIP_CLAIMS, so nothing decides it. If the consumer');
        console.log('  has it in .harness/decision-policy.json, it is consumer-owned by default: no provision');
        console.log('  writes it, so it survives. If it is NEW product surface, add a row (see qc test).');
        return;
    }
    console.log(`${row.matched}  → ${row.owner}`);
    if (row.matched !== row.path) console.log(`  matched     parent subtree "${row.matched}" for "${dotted}"`);
    console.log(`  question    ${row.question}`);
    console.log(`  written by  ${row.writtenBy}`);
    console.log(`  declared in ${row.declaredIn}`);
}
