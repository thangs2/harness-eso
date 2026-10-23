import fs from 'node:fs';
import path from 'node:path';
import { buildProvisionPlan, deepMergePolicyObjects } from './project-registry.mjs';

/**
 * Who owns which value in a consumer's `decision-policy.json`?
 *
 * ## The question this answers
 *
 * The product owns the **mechanism** (hooks, guards, sidecar, policy schema, default adapters); the
 * consumer owns the **values** (`paths.locked`, `sot`, the real Brain tier, which adapters are on,
 * `SDLC/`). That sentence is true, and until 2026-10-23 it lived only in prose — so an operator asking
 * "is this key mine or the product's?" had to read `init-profile.mjs`, `project-registry.mjs` and the
 * consumer's JSON side by side. Three places, one answer, and no way to tell a value they tuned from a
 * value the next `./provision.sh` will replace.
 *
 * ## Why it re-plans instead of re-deriving
 *
 * "What the product would write" is `buildProvisionPlan`'s answer and nothing else. Re-implementing
 * the profile → project → catalog merge here would produce a report that agrees with provision today
 * and silently disagrees after the next profile change — a second source of truth for the one thing
 * this report exists to describe. So the report **calls the same planner** in dry-run mode.
 *
 * ## The three states, and the one that matters
 *
 *   `product`   the plan defines the key and the consumer's file does not contradict it (absent, or
 *               identical). Safe: a re-provision changes nothing.
 *   `overridden` the plan defines the key at a different value than the consumer's file. The next
 *               `init profile` **replaces** it — the product wins by design (`deepMergePolicyObjects`
 *               applies the plan over the prior document), and that is the failure this report names.
 *   `operator`  the key exists only in the consumer's file. The plan never touches it; it survives
 *               every provision. This is the half of the file the consumer genuinely owns today.
 *
 * Arrays are compared as whole values, for the same reason the merge treats them as whole values: a
 * shipped `paths.locked` list replaces an operator-edited one, it does not union with it. Reporting a
 * partial diff there would suggest a merge that does not happen.
 *
 * ## What it deliberately cannot answer
 *
 * Whether an `overridden` key *should* differ. `eso.enforceWrites: off` on one consumer may be a
 * considered decision (the runbook says enabling Jev/L3 is the consumer's call) or a stale default
 * nobody revisited. The report says "the product would write X, the file says Y" — the judgment stays
 * with the operator, because the consumer's git history is the evidence and this module never reads it.
 */

/** Dotted paths whose value the plan defines, e.g. `eso.sources.law.enabled`. */
function leafPaths(value, prefix = '') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    const keys = Object.keys(value);
    if (!keys.length) return [prefix];
    return keys.flatMap((k) => leafPaths(value[k], prefix ? `${prefix}.${k}` : k));
}

function valueAt(obj, dotted) {
    let cur = obj;
    for (const part of dotted.split('.')) {
        if (cur === null || typeof cur !== 'object' || !(part in cur)) return { found: false };
        cur = cur[part];
    }
    return { found: true, value: cur };
}

/** Structural equality, arrays included: the merge replaces arrays, so a shallow compare would lie. */
export function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => sameValue(x, b[i]));
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && sameValue(a[k], b[k]));
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

const DEFAULT_POLICY_RELATIVE = '.harness/decision-policy.json';

/**
 * Where the declaration of a key's owner lives, for the one time the report cannot say it from the file.
 *
 * A key with no plan entry is unambiguously the consumer's (nothing will ever overwrite it). A key the
 * plan *does* define may still be the consumer's by declaration — the shipped list is a default, and the
 * runbook names the consumer as the Source of Truth. These are the declarations, and each cites the
 * document that makes the claim; nothing here is inferred from the value.
 */
const OWNER_DECLARED = {
    'paths.locked': 'documents/02.runtime/08.provisioning-consumers.md §8 — "nguồn Truth của consumer"',
    'paths.gated': 'same as paths.locked',
    'paths.ask': 'same as paths.locked',
    'paths.sot': 'same as paths.locked',
    'jev.mode': '08.provisioning-consumers.md §8 — enabling Jev/L3 is the consumer’s decision',
    'fallback.l3_flash': 'same as jev.mode',
    'harnessConsole.brain.adapterId': 'same as jev.mode (a Brain adapter needs the consumer’s key)',
};
/**
 * Diff the policy a provision **would** write against the one the consumer **has**.
 *
 * @param {Record<string, any>} current   parsed consumer policy (or `{}` when the file is new)
 * @param {Record<string, any>} planned   `buildProvisionPlan(...).files[].preview` for the policy file
 * @returns {{ product: string[], overridden: {path: string, current: any, planned: any}[], operator: string[] }}
 */
export function classifyPolicyOwnership(current, planned) {
    const cur = current && typeof current === 'object' ? current : {};
    const plan = planned && typeof planned === 'object' ? planned : {};
    const product = [];
    const overridden = [];
    const operator = [];
    for (const p of leafPaths(plan)) {
        const c = valueAt(cur, p);
        if (!c.found) product.push(p);
        else if (sameValue(c.value, valueAt(plan, p).value)) product.push(p);
        else overridden.push({ path: p, current: c.value, planned: valueAt(plan, p).value });
    }
    // Keys the plan does not define survive the merge untouched — that is the `deepMergePolicyObjects`
    // contract, not an assumption. A subtree the plan never mentions is reported as ONE path
    // (`operatorGroups`) rather than one line per key: `sot` can be a hundred entries deep and listing
    // each makes the report unreadable, which is how a report stops being read.
    for (const p of operatorGroups(cur, plan)) operator.push(p);
    return { product, overridden, operator };
}

/** Top-most subtrees of `cur` that `plan` never defines, as dotted paths. */
function operatorGroups(cur, plan) {
    const out = [];
    const walk = (node, prefix) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
            out.push(prefix);
            return;
        }
        for (const k of Object.keys(node)) {
            const p = prefix ? `${prefix}.${k}` : k;
            const v = valueAt(plan, p);
            if (v.found) {
                // Plan defines this node: descend so only genuinely-operator children are reported.
                if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) walk(node[k], p);
                continue;
            }
            out.push(p);
        }
    };
    walk(cur, '');
    return out;
}

/**
 * Full ownership report for one consumer repo.
 *
 * Takes a **plan**, not a project: `runInitProfile` builds the plan one line before it writes, and a
 * report that re-derived it from `projectDraftForConsumer()` would describe the draft rather than the
 * provision — same directory, different policy, and the difference is exactly what an operator asks
 * this command about. Callers that only have a project can `buildProvisionPlan` themselves.
 *
 * @param {string} root consumer path (absolute)
 * @param {ReturnType<typeof buildProvisionPlan>} plan
 */
export function buildOwnershipReport(root, plan) {
    const policyFile = plan.files.find((f) => f.relative === DEFAULT_POLICY_RELATIVE);
    const policyPath = path.join(root, DEFAULT_POLICY_RELATIVE);
    const current = fs.existsSync(policyPath) ? readJson(policyPath) : {};
    const planned = policyFile?.preview ?? {};
    const policy = current === null
        ? {
              state: 'unreadable',
              detail: `${DEFAULT_POLICY_RELATIVE} exists but is not valid JSON — every gate reads this file, fix it before anything else`,
              product: [],
              overridden: [],
              operator: [],
          }
        : {
              state: fs.existsSync(policyPath) ? 'present' : 'absent',
              detail: fs.existsSync(policyPath)
                  ? 'keys are classified by comparing the provision plan against the file'
                  : 'no policy file yet — the next provision creates it from the plan, nothing is operator-owned',
              ...classifyPolicyOwnership(current, planned),
          };
    /*
     * `product` is truthful and, on its own, misleading: it means "the plan writes this path", not "the
     * product owns the value". `paths.locked` sits there because the shipped profile carries a default
     * list — while the provisioning runbook says that list is the consumer's Source of Truth. Both are
     * true; distinguishing a shipped default from an operator decision is a judgment this report does
     * not make, so it records the source instead (see OWNER_DECLARED) and lets the reader decide.
     */
    return {
        root,
        policyFile: DEFAULT_POLICY_RELATIVE,
        policy,
        declared: reportDeclared(policy),
        // Re-applying the merge to what is on disk (or to nothing) is what a provision will produce.
        // Exposed because "the product plans X, the file says Y" is only actionable next to "so the
        // file becomes X" — and on a fresh consumer that answer is simply the plan.
        afterProvision: current === null ? null : deepMergePolicyObjects(current, planned),
    };
}

/** `path → declaration` for every key the report lists that the runbook assigns to the consumer. */
function reportDeclared(policy) {
    const out = {};
    for (const p of [...policy.product, ...policy.overridden.map((o) => o.path), ...policy.operator]) {
        if (OWNER_DECLARED[p]) out[p] = OWNER_DECLARED[p];
    }
    return out;
}

/** A one-line verdict for `init report`: is there anything an operator must decide? */
export function ownershipVerdict(report) {
    if (report.policy.state === 'unreadable') return 'broken';
    if (report.policy.overridden.length) return 'drift';
    return 'in-sync';
}

/** Human `init report` output. Every line names a state, never a bare value list. */
export function renderOwnershipReport(report, { guardFreshness = null } = {}) {
    const lines = [];
    lines.push(`init report  ${report.root}`);
    lines.push(`  policy       ${report.policyFile} — ${report.policy.state}`);
    lines.push(`  verdict      ${ownershipVerdict(report)}`);
    lines.push('');
    const section = (title, rows, fmt) => {
        lines.push(`  ${title}`);
        if (!rows.length) {
            lines.push('    (none)');
            return;
        }
        for (const r of rows) lines.push(`    ${fmt(r)}`);
    };
    section('product-owned (the plan writes these; a re-provision is a no-op)', report.policy.product, (p) =>
        OWNER_DECLARED[p] ? `${p}  (consumer-declared: ${OWNER_DECLARED[p]})` : p,
    );
    section(
        'OVERRIDDEN — the file disagrees with the plan; the next `init profile` replaces these',
        report.policy.overridden,
        (o) => `${o.path}  file=${JSON.stringify(o.current)}  plan=${JSON.stringify(o.planned)}`,
    );
    section(
        'consumer-owned (no plan key; survives every provision)',
        report.policy.operator,
        (p) => p,
    );
    if (report.policy.detail) {
        lines.push('');
        lines.push(`  note         ${report.policy.detail}`);
    }
    if (guardFreshness) {
        lines.push('');
        lines.push(`  guards       ${guardFreshness.status} — ${guardFreshness.detail}`);
    }
    return lines.join('\n');
}
