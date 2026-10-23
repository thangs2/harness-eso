import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entryCommand, mergeHooksDocument } from './hook-merge.mjs';
import { writeJsonAtomic } from './workspace-store.mjs';

const GENERIC_PKG = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../harness-host-generic/src',
);
const OBSERVE_PKG = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../harness-observe-server/src',
);
void OBSERVE_PKG;

/** Built host pack — one bundled dispatcher plus its Python route helper. */
const HOST_PACK_SRC = path.resolve(GENERIC_PKG, '..', 'dist', 'host-pack');
/** Where the pack is installed inside a consumer, as a POSIX-relative path. */
export const HOST_PACK_REL = '.harness/host-pack';

/**
 * The consumer `.harness/.gitignore` convention, and what must be allowed through it.
 *
 * Consumers ship a `.harness/.gitignore` that ignores **everything** and re-admits a few files —
 * x79's is exactly `*` + `!.gitignore` + `!README.md` + `!decision-policy.json`. That is a sensible
 * default for a directory that is regrown by a provision, and this module keeps it.
 *
 * The **host pack** is therefore not in a clone, and the consequence is real: `hooks.json` points at
 * `.harness/host-pack/harness-hook.mjs`, which a fresh clone does not have, so every hook fails and
 * every guard fails closed until the consumer provisions again. That is the operator's choice — the
 * pack is build output of a specific release, rewritten by every provision. `verify consumer` reports
 * a missing pack, and `provision.sh <consumer>` restores it in one command.
 *
 * So provisioning makes sure the rules exist. It is additive and idempotent: operator rules are
 * never removed or reordered, missing re-admissions are appended under a marker, and the runtime
 * exclusions (`harness.db`, its WAL siblings, `cache/`) stay in effect.
 *
 * `.harness/` is **entirely machine-local**: everything the provision writes there belongs to one
 * checkout, and the only two files admitted are the ones that describe the rules themselves.
 *
 * That is a deliberate reversal. The directory used to advertise a "team contract" — the policy, the
 * integrations map, the operator docs — but nothing enforced it: the pack, the bootstrap stamp and our
 * hook ledger were admitted alongside them, every provision rewrote them, and `git status` was dirty
 * after a clone. Deciding by *kind of machine* instead of *kind of file* is what stops that drift.
 * A consumer that wants a file in its repository says so with a `!` rule of its own, and
 * `ensureHarnessGitignore` never removes it.
 */
const GITIGNORE_MARKER = '# harness-eso: files this tool writes that must be committed';
const GITIGNORE_ADMIT = [
    '!.gitignore',
    '!README.md',
];
/*
 * Rules earlier releases admitted into `.harness/.gitignore`. Nothing merges them by hand, so a consumer
 * can only still carry them because a provision wrote them — which is what makes them safe to delete on
 * sight, and deleting them is what lets the allowlist converge. Without this list the old one is
 * permanent: every rule still looks present, the file is reported "skip", and the host pack stays
 * committed in a repository that has stopped admitting it.
 */
const GITIGNORE_RETIRED = [
    '!host-bootstrap.json',
    '!host-install-state.json',
    '!host-pack/',
    '!host-pack/**',
    '!decision-policy.json',
    '!integrations.json',
    '!WORKFLOW_GUIDE.md',
    '!ONBOARDING.md',
    '!diagnostics.sh',
    '!sidecar.env.example',
    '!eso-coverage.json',
];

/*
 * Everything a session writes. Two mechanisms used to disagree about this: the consumer's root
 * `.gitignore` carried a hand-maintained subset, and `session/` had no ignore of its own, so each new
 * artifact (`*.json`) stayed tracked until somebody noticed. The failure is social, not technical — a
 * tracked session file makes `git status` dirty after every turn, and the cheapest way to get a clean
 * tree is to commit another developer's preflight verdict.
 *
 * `session/README.md` stays committed: the one file in that directory that describes rather than
 * records, and a directory whose purpose is undocumented is one people delete. It is spelled with a
 * `**\/session/` prefix rather than the sibling pattern plus an exception, because two adjacent
 * slash-star sequences in a parameter expansion terminate a block comment — which is how a correct
 * ignore list once managed to break the module it lived in.
 */
const GITIGNORE_RUNTIME = [
    'sidecar.env',
    '*/session/*',
];
const GITIGNORE_RUNTIME_ADMIT = ['!**/session/README.md'];
const GITIGNORE_RUNTIME_MARKER = '# harness-eso: per-user session state, never commit';

/**
 * Ensure `.harness/.gitignore` says what belongs to this checkout — which is everything but the rules
 * themselves.
 *
 * The directory is regrown by a provision: the installed host pack, the sidecar token, the bootstrap
 * stamp, our hook ledger, the database and the caches, and — through the session rules — the per-turn
 * verdicts each developer's own agent writes. All of it describes one machine.
 *
 * Additive and idempotent: operator rules are never removed or reordered. Our runtime block is
 * re-emitted when one of its rules is missing, because a runtime rule that silently disagrees with the
 * product is how a tracked session file gets committed by hand.
 *
 * @param {string} root consumer root
 * @returns {{ relative: string, action: 'write' | 'skip' }}
 */
export function ensureHarnessGitignore(root) {
    const file = path.join(root, '.harness', '.gitignore');
    const relative = '.harness/.gitignore';

    let existing = '';
    let isNew = false;
    try {
        existing = fs.readFileSync(file, 'utf8');
    } catch {
        isNew = true;
        existing = '*\n!.gitignore\n!README.md\n';
    }

    const runtimeSet = new Set(GITIGNORE_RUNTIME);
    /*
     * The re-admissions **this tool used to write**. Only these are removable when the product stops
     * admitting them: distinguishing them from an operator's own rule needs a history, and the product
     * is the only side that has one. A rule nobody here ever wrote belongs to the consumer and is kept.
     */
    const retired = new Set(GITIGNORE_RETIRED);
    /*
     * `README.md` is admitted by pattern, not by name: the blanket plus the session block would
     * otherwise swallow the session README even though an un-ignore appears above it — gitignore
     * evaluates the *last* matching rule, and the session block comes later. Emitting the exception
     * after the block is what makes it hold.
     */
    const unIgnorable = new Set([...GITIGNORE_ADMIT, ...GITIGNORE_RUNTIME_ADMIT]);
    const filteredLines = [];
    let inRuntimeBlock = false;
    for (const l of existing.split('\n')) {
        const trimmed = l.trim();
        if (trimmed === GITIGNORE_RUNTIME_MARKER) {
            inRuntimeBlock = true;
            continue;
        }
        if (inRuntimeBlock) {
            /*
             * The block used to be scanned by value, so a retired runtime rule ended the block and was
             * then kept as if the operator had written it. Scan to the next blank line or a foreign
             * rule instead: membership in `ours` is what decides, not position.
             */
            if (!trimmed || (!runtimeSet.has(trimmed) && !unIgnorable.has(trimmed))) inRuntimeBlock = false;
            else continue;
        }
        if (trimmed === GITIGNORE_MARKER) continue;
        if (unIgnorable.has(trimmed)) continue;
        /*
         * A retired re-admission is removed, not preserved. Leaving it made the previous allowlist
         * permanent: `missing` is computed from rules that were never absent, so the run reported
         * "skip" and a consumer provisioning after the change kept `.harness/host-pack/` committed.
         *
         * Only lines this tool used to write are eligible — a re-admission the consumer added for
         * itself is theirs and survives.
         */
        if (retired.has(trimmed)) continue;
        filteredLines.push(l);
    }

    const present = new Set(
        filteredLines
            .map((l) => l.trim())
            .filter(Boolean),
    );
    /*
     * The output, not the input, decides whether anything changed: comparing the filtered input called
     * every run a rewrite, because a rewrite always normalises the blank lines a previous run left.
     */
    let body = filteredLines.join('\n');
    body = body.trimEnd() + '\n';
    if (!present.has('*')) {
        body = '*' + '\n' + body;
    }
    const admitMissing = GITIGNORE_ADMIT.filter((rule) => !present.has(rule));
    const runtimeMissing = GITIGNORE_RUNTIME.filter((rule) => !present.has(rule));
    const runtimeAdmitMissing = GITIGNORE_RUNTIME_ADMIT.filter((rule) => !present.has(rule));
    if (admitMissing.length) body += admitMissing.join('\n') + '\n';
    if (runtimeMissing.length || runtimeAdmitMissing.length) {
        body += GITIGNORE_RUNTIME_MARKER + '\n';
        if (runtimeMissing.length) body += runtimeMissing.join('\n') + '\n';
        if (runtimeAdmitMissing.length) body += runtimeAdmitMissing.join('\n') + '\n';
    }

    if (!isNew && body === existing) return { relative, action: 'skip' };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    return { relative, action: 'write' };
}

/** The paths whose ignore status decides whether a file must leave the index. */
const TRACKED_PROBE = [
    '.harness/sidecar.env',
    '.harness/host-bootstrap.json',
    '.harness/host-install-state.json',
];

function gitLines(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.split('\0').join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Release the `.harness/` paths git still tracks although our rules ignore them.
 *
 * Git never re-checks the ignore rules for a file that is already in the index, so the ignore block
 * above cannot save a consumer that committed a machine-local file before the rule existed: the next
 * provision rewrites it, and `git status` turns dirty for a repo that is supposed to be clean. Every
 * consumer provisioned before the host pack stopped being admitted is in that state, and the three
 * records named in `TRACKED_PROBE` are the ones a consumer may have committed by hand.
 *
 * The candidate set is every tracked path under `.harness/` — not a hard-coded list, because the list
 * is what drifted from the rules in the first place. A path is released only when the rules say it is
 * ignored, so a consumer's own `!` exception (the one file it decided to version) is never removed.
 *
 * Two outcomes, because a file can be gone and still be tracked:
 *
 *   released — on disk, our rules ignore it, so it leaves the index and stays on disk for the operator
 *   deleted  — no longer on disk but still in the index; only the index entry can be removed, and
 *              leaving it is what makes a deleted file show up as a deletion in every teammate's tree
 *
 * Staging a removal is not the same as committing one: the operator reviews `git rm --cached` and
 * decides.
 *
 * @param {string} root consumer root
 * @returns {{ released: string[], deleted: string[] }} empty arrays when there is nothing to do
 */
export function untrackIgnoredPaths(root) {
    const result = { released: [], deleted: [] };
    const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
    if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return result;

    const tracked = gitLines(root, ['ls-files', '-z', '--', '.harness']) ?? [];
    for (const rel of [...new Set([...tracked, ...TRACKED_PROBE])]) {
        if (gitLines(root, ['ls-files', '--error-unmatch', '--', rel]) === null) continue;
        /*
         * Asked with `--no-index`: once the path is in the index git calls it tracked in that very
         * answer, so the question comes back "not ignored" for exactly the file this function exists to
         * release. `--no-index` asks the rules as if the path were untracked — which is the case the
         * rule has to decide — and keeps a consumer override (`!sidecar.env`) winning when it states one.
         */
        const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', rel], { cwd: root });
        if (ignored.status !== 0) continue;
        const present = fs.existsSync(path.join(root, rel));
        const removed = spawnSync(
            'git',
            ['rm', '--cached', '--quiet', ...(present ? [] : ['--ignore-unmatch']), '--', rel],
            { cwd: root },
        );
        if (removed.status !== 0) continue;
        (present ? result.released : result.deleted).push(rel);
    }
    return result;
}

/**
 * Our record of what we wrote into a consumer's host config.
 *
 * Kept in `.harness/` rather than inside `hooks.json` because that file belongs to the host
 * application — see `hook-merge.mjs` for why. It is what makes the merge three-way: without it the
 * only options are "clobber" and "duplicate".
 */
export const HOST_STATE_REL = '.harness/host-install-state.json';

export function readHostState(root) {
    const fp = path.join(root, HOST_STATE_REL);
    if (!fs.existsSync(fp)) return { version: 1, hooks: {}, docs: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return { version: 1, hooks: raw?.hooks || {}, docs: raw?.docs || {} };
    } catch {
        // A corrupt state file must not abort a provision; the worst case is one duplicate that
        // the next run compacts away.
        return { version: 1, hooks: {}, docs: {} };
    }
}

/**
 * Write our record. The document holds more than hooks — `docs` is the other bookkeeping that has to
 * survive a provision (the hashes in `syncConsumerDoc`), so it is carried through rather than dropped.
 */
function writeHostState(root, state) {
    const fp = path.join(root, HOST_STATE_REL);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJsonAtomic(fp, { version: 1, hooks: state.hooks || {}, docs: state.docs || {} });
    return { relative: HOST_STATE_REL, action: 'write' };
}

function sha256File(fp) {
    return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

/**
 * Copy one provisioned document into a consumer, keeping whatever the developer changed.
 *
 * Copy-only-when-missing was safe but left every consumer pinned to the documents of the release that
 * first created them: a checklist describing a `diagnostics.sh` from an older release sends the
 * operator to commands that no longer exist, and the only way out was `harnessctl fix docs`, which
 * overwrites unconditionally. Neither answer is right, so this is the three-way one.
 *
 * The state file remembers the hash of the bytes **we** wrote, and those hashes compare against two
 * other versions: the template now, and the file now. That is enough to tell "nobody touched it,
 * refresh it" from "somebody edited it, leave it alone" — no markers to remember, no flag to pass.
 *
 * @param {string} root consumer root
 * @param {{ src: string[], rel: string, exec?: boolean }} doc consumer-relative destination
 * @param {object} docs the `docs` section of the host state, updated in place
 * @returns {{relative: string, action: 'created'|'updated'|'kept'|'kept-edited'|'kept-foreign'}|null}
 */
export function syncConsumerDoc(root, doc, docs = {}) {
    const baseProfiles = process.env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT;
    const src = path.join(baseProfiles, ...doc.src);
    if (!fs.existsSync(src)) return null;
    const dest = path.join(root, doc.rel);
    const record = docs[doc.rel] || {};
    const tplHash = sha256File(src);

    let action;
    if (!fs.existsSync(dest)) {
        action = 'created';
    } else {
        const curHash = sha256File(dest);
        if (record.sha256 && record.sha256 === curHash) {
            // Untouched since we wrote it: the only version that can be stale is the template's.
            if (curHash === tplHash) return null;
            action = 'updated';
        } else if (record.sha256) {
            action = 'kept-edited';
        } else {
            // Present with no record — a copy from a release that predates this bookkeeping. It may be
            // stock, but an edit made to it is indistinguishable from stock, so it is the operator's.
            action = 'kept-foreign';
        }
    }

    if (action === 'created' || action === 'updated') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fs.readFileSync(src));
        if (doc.exec) {
            try {
                fs.chmodSync(dest, 0o755);
            } catch {
                /* Windows: the mode is meaningless and bash is not the entrypoint there */
            }
        }
        docs[doc.rel] = { sha256: tplHash, syncedAt: new Date().toISOString() };
    } else if (!record.sha256) {
        // Adopt the current bytes as the baseline so a future template change is not reported as an
        // edit forever; the file itself stays exactly as it is now.
        docs[doc.rel] = { sha256: sha256File(dest), syncedAt: record.syncedAt || null, adopted: true };
    }
    return { relative: doc.rel, action };
}

function writeSidecarEnv(root, profileIds, port) {
    const sidecarUrl = `http://127.0.0.1:${port}`;
    const sidecarEnvPath = path.join(root, '.harness', 'sidecar.env');
    const sidecarExamplePath = path.join(root, '.harness', 'sidecar.env.example');
    const envLines = [
        `# Generated by harness-eso host profiles: ${profileIds.join(', ')}`,
        `HARNESS_SIDECAR_URL=${sidecarUrl}`,
        `HARNESS_OBSERVE_URL=${sidecarUrl}`,
        `HARNESS_REPO_ROOT=${path.resolve(root)}`,
        '# HARNESS_TREE set per IDE hook command (cursor / agents)',
    ];
    fs.mkdirSync(path.dirname(sidecarEnvPath), { recursive: true });
    fs.writeFileSync(sidecarEnvPath, `${envLines.join('\n')}\n`);

    if (!fs.existsSync(sidecarExamplePath)) {
        const exampleLines = [
            '# Example sidecar environment template — copy to sidecar.env for local overrides',
            `# Generated by harness-eso host profiles: ${profileIds.join(', ')}`,
            `HARNESS_SIDECAR_URL=http://127.0.0.1:${port}`,
            `HARNESS_OBSERVE_URL=http://127.0.0.1:${port}`,
            '# HARNESS_REPO_ROOT=<path-to-repo-root-on-your-machine>',
            '# HARNESS_TREE set per IDE hook command (cursor / agents)',
        ];
        fs.writeFileSync(sidecarExamplePath, `${exampleLines.join('\n')}\n`);
    }

    return { relative: '.harness/sidecar.env', action: 'write' };
}

const PROFILES_DIR_DEFAULT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../profiles',
);

/**
 * Ensure consumer guard templates exist in the target IDE tree.
 * Creates .<treeKey>/hooks/guard-write.py and guard-shell.py (and pre-tool-use.py for agents)
 * only if missing on disk, preserving existing operator customizations.
 */
export function ensureConsumerGuards(root, treeKey) {
    const baseProfiles = process.env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT;
    const templatesDir = path.join(baseProfiles, 'templates', 'hooks');
    if (!fs.existsSync(templatesDir)) return [];

    const actions = [];
    const targetHooksDir = path.join(root, `.${treeKey}`, 'hooks');
    fs.mkdirSync(targetHooksDir, { recursive: true });

    const filesToEnsure = ['guard-write.py', 'guard-shell.py'];
    if (treeKey === 'agents') {
        filesToEnsure.push('pre-tool-use.py');
    }

    for (const name of filesToEnsure) {
        const dest = path.join(targetHooksDir, name);
        if (!fs.existsSync(dest)) {
            const src = path.join(templatesDir, name);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
                try {
                    fs.chmodSync(dest, 0o755);
                } catch {
                    /* chmod best effort */
                }
                actions.push({ relative: `.${treeKey}/hooks/${name}`, action: 'created' });
            }
        }
    }
    return actions;
}

/**
 * Rewrite a consumer's guard files from the shipped templates — the **explicit** path.
 *
 * `ensureConsumerGuards` above is `create-if-missing`, on purpose: it runs on every provision, and a
 * provision must never overwrite something an operator edited. But "never overwrite" without a way to
 * overwrite left no upgrade path at all: atrievefin, 2026-10-23, ran a `guard-write.py` from before the
 * deny-message fix through a `./provision.sh --force` that reported success (G-17). This function is
 * that path, and it is only ever called by a command that names it.
 *
 * The rules that keep it safe:
 *
 *   - every file it is about to replace is first copied to `<name>.bak-<timestamp>` (one per run, so a
 *     second run does not shadow the operator's original);
 *   - a file that looks operator-owned (a `def` the template does not have, or the explicit marker) is
 *     **skipped** unless `force` is set, and the skip is reported with the reason a human needs;
 *   - a file that is already identical is reported as `current` and not touched — no timestamp churn,
 *     so `git status` stays quiet on an up-to-date consumer.
 *
 * @param {string} root consumer root
 * @param {{ treeKeys?: string[], force?: boolean, dryRun?: boolean }} [opts]
 * @returns {{ actions: { file: string, action: 'updated'|'current'|'skipped'|'created', backup?: string, reason?: string }[], templatesDir: string }}
 */
export function syncConsumerGuards(root, opts = {}) {
    const baseProfiles = process.env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT;
    const templatesDir = path.join(baseProfiles, 'templates', 'hooks');
    const treeKeys =
        Array.isArray(opts.treeKeys) && opts.treeKeys.length
            ? opts.treeKeys
            : ['cursor', 'claude', 'agents'].filter((k) => fs.existsSync(path.join(root, `.${k}`)));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const actions = [];

    for (const treeKey of treeKeys) {
        const targetHooksDir = path.join(root, `.${treeKey}`, 'hooks');
        for (const name of ['guard-write.py', 'guard-shell.py', 'pre-tool-use.py']) {
            const src = path.join(templatesDir, name);
            if (!fs.existsSync(src)) continue;
            const dest = path.join(targetHooksDir, name);
            const shown = `.${treeKey}/hooks/${name}`;

            if (!fs.existsSync(dest)) {
                if (!opts.dryRun) {
                    fs.mkdirSync(targetHooksDir, { recursive: true });
                    fs.copyFileSync(src, dest);
                    try {
                        fs.chmodSync(dest, 0o755);
                    } catch {
                        /* best effort, as above */
                    }
                }
                actions.push({ file: shown, action: 'created' });
                continue;
            }

            const mine = fs.readFileSync(dest, 'utf8');
            const shipped = fs.readFileSync(src, 'utf8');
            if (mine === shipped) {
                actions.push({ file: shown, action: 'current' });
                continue;
            }

            /*
             * Operator-owned: a `def` the template does not ship, or the explicit marker. Refusing by
             * default is the same rule `ensureConsumerGuards` follows; the difference is that this
             * command can say *no* out loud and tell the operator how to override it.
             */
            const shippedDefs = new Set([...shipped.matchAll(/^def ([a-z_][\w]*)/gm)].map((m) => m[1]));
            const extraDefs = [...mine.matchAll(/^def ([a-z_][\w]*)/gm)].map((m) => m[1]).filter((d) => !shippedDefs.has(d));
            const marked = /HARNESS: (customised|operator-owned)\b/i.test(mine);
            if ((extraDefs.length || marked) && !opts.force) {
                actions.push({
                    file: shown,
                    action: 'skipped',
                    reason: marked
                        ? 'marked operator-owned (HARNESS: customised) — pass --force to replace'
                        : `carries ${extraDefs.length} function(s) the template does not ship (${extraDefs.slice(0, 3).join(', ')}) — pass --force to replace`,
                });
                continue;
            }

            const backup = `${dest}.bak-${stamp}`;
            if (!opts.dryRun) {
                fs.copyFileSync(dest, backup);
                fs.copyFileSync(src, dest);
            }
            actions.push({ file: shown, action: 'updated', backup: path.relative(root, backup) });
        }
    }
    return { actions, templatesDir };
}

/**
 * Ensure baseline token-diet compliant micro-rules exist in target IDE tree.
 * Creates .<treeKey>/rules/core.conversation-hygiene.mdc, core.pipeline-gate.mdc,
 * and core.scope-fallback.mdc only if missing on disk.
 */
export function ensureConsumerRules(root, treeKey) {
    const baseProfiles = process.env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT;
    const templatesDir = path.join(baseProfiles, 'templates', 'rules');
    if (!fs.existsSync(templatesDir)) return [];

    const actions = [];
    const targetRulesDir = path.join(root, `.${treeKey}`, 'rules');
    fs.mkdirSync(targetRulesDir, { recursive: true });

    // Eager core.* (token-diet) + scoped workflow/delivery (alwaysApply:false in templates).
    const ruleNames = [
        'core.law-gate.mdc',
        'core.conversation-hygiene.mdc',
        'core.pipeline-gate.mdc',
        'core.scope-fallback.mdc',
        'workflow.agentic-factory.mdc',
        'workflow.qc-runtime.mdc',
        'delivery.workflow.mdc',
    ];

    for (const name of ruleNames) {
        const dest = path.join(targetRulesDir, name);
        const altDest = (treeKey === 'agents' || treeKey === 'claude') ? path.join(targetRulesDir, name.replace(/\.mdc$/, '.md')) : null;
        if (!fs.existsSync(dest)) {
            const src = path.join(templatesDir, name);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
                actions.push({ relative: `.${treeKey}/rules/${name}`, action: 'created' });
            }
        }
        if (altDest && !fs.existsSync(altDest)) {
            const src = path.join(templatesDir, name);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, altDest);
                actions.push({ relative: `.${treeKey}/rules/${path.basename(altDest)}`, action: 'created' });
            }
        }
    }

    // Seed instructions.md in .cursor/ or .agents/ if missing
    const instructionsDest = path.join(root, `.${treeKey}`, 'instructions.md');
    if (!fs.existsSync(instructionsDest)) {
        const instructionsSrc = path.join(baseProfiles, 'templates', 'instructions.md');
        if (fs.existsSync(instructionsSrc)) {
            fs.copyFileSync(instructionsSrc, instructionsDest);
            actions.push({ relative: `.${treeKey}/instructions.md`, action: 'created' });
        }
    }

    return actions;
}

/**
 * Ensure core ESO skills (eso-recon, eso-verify) exist in consumer IDE tree.
 */
export function ensureConsumerSkills(root, treeKey) {
    const baseProfiles = process.env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT;
    const templatesDir = path.join(baseProfiles, 'templates', 'skills');
    if (!fs.existsSync(templatesDir)) return [];

    const actions = [];
    const targetSkillsDir = path.join(root, `.${treeKey}`, 'skills');

    try {
        const entries = fs.readdirSync(templatesDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillName = entry.name;
            const destDir = path.join(targetSkillsDir, skillName);
            const destSkillFile = path.join(destDir, 'SKILL.md');
            const srcSkillFile = path.join(templatesDir, skillName, 'SKILL.md');
            if (!fs.existsSync(destSkillFile) && fs.existsSync(srcSkillFile)) {
                fs.mkdirSync(destDir, { recursive: true });
                fs.copyFileSync(srcSkillFile, destSkillFile);
                actions.push({ relative: `.${treeKey}/skills/${skillName}/SKILL.md`, action: 'created' });
            }
        }
    } catch {
        /* best-effort skill provisioning */
    }

    return actions;
}

/**
 * Ensure .<treeKey>/session/ is in consumer root .gitignore.
 */
export function ensureSessionGitignore(root, treeKey) {
    const rootGitignore = path.join(root, '.gitignore');
    if (!fs.existsSync(rootGitignore)) return [];

    /*
     * Contents, not the directory. A `.gitignore` line ending in `/` matches the directory and nothing
     * inside it, and git never evaluates rules for the contents of an excluded directory — so the
     * README exception that follows would be unreachable. `.cursor/session/*` keeps the directory
     * traversable, which is what lets the exception admit one file.
     */
    const lines = [`.${treeKey}/session/*`, `!.${treeKey}/session/README.md`];
    try {
        const content = fs.readFileSync(rootGitignore, 'utf8');
        const present = new Set(content.split('\n').map((l) => l.trim()));
        const missing = lines.filter((l) => !present.has(l));
        if (!missing.length) return [];
        fs.writeFileSync(rootGitignore, `${content.trimEnd()}\n${missing.join('\n')}\n`, 'utf8');
        return [{ relative: '.gitignore', action: 'updated' }];
    } catch {
        /* best-effort gitignore update */
    }
    return [];
}

/**
 * Ensure comprehensive consumer workflow guide exists in .harness/WORKFLOW_GUIDE.md.
 *
 * Refreshed when it is still the copy we wrote and the template moved on; a consumer that edited its
 * own copy keeps it. See `syncConsumerDoc` for how the three versions are told apart.
 */
export function ensureConsumerWorkflowGuide(root, docs = {}) {
    const result = syncConsumerDoc(root, { src: ['templates', 'WORKFLOW_GUIDE.md'], rel: '.harness/WORKFLOW_GUIDE.md' }, docs);
    return result ? [result] : [];
}

/**
 * Seed the two artefacts an operator reads after a provision: the layer checklist and the read-only
 * diagnostic it tells them to run.
 *
 * `WORKFLOW_GUIDE.md` explains how the harness works, which is the wrong shape for "I just installed
 * this, what do I do now": an operator needs an ordered list per layer and one command that reports
 * which layer is wrong. The guide is a reference, this is the entry point, and neither replaces the
 * other. Both are copied **only when absent** — a consumer that edited its own copy keeps it.
 *
 * `diagnostics.sh` is written executable: a script the operator has to `chmod` is a script that
 * reports "permission denied" on the one run that mattered.
 *
 * @param {string} root consumer root
 * @param {object} [docs] the `docs` section of the host state, updated in place
 * @returns {{relative: string, action: string}[]}
 */
export function ensureConsumerOnboarding(root, docs = {}) {
    const files = [
        { src: ['templates', 'ONBOARDING.md'], rel: '.harness/ONBOARDING.md', exec: false },
        { src: ['templates', 'diagnostics.sh'], rel: '.harness/diagnostics.sh', exec: true },
    ];
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    const actions = [];
    for (const file of files) {
        const result = syncConsumerDoc(root, file, docs);
        if (result) actions.push(result);
    }
    return actions;
}

/**
 * Ensure Claude Code baseline integration exists in consumer:
 * 1. CLAUDE.md with law-gate marker pointing to AGENTS.md
 * 2. .mcp.json at root copied from .cursor/mcp.json if missing
 * 3. Root .gitignore ignoring .claude/session/ and .claude/settings.local.json
 */
export function ensureConsumerClaudeSupport(root) {
    const actions = [];

    // 1. Ensure CLAUDE.md exists with law-gate marker
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    const marker = '# harness-eso: law-gate';
    if (!fs.existsSync(claudeMdPath)) {
        const body = `# Claude Code Guidelines\n\n${marker}\nTất cả các phiên làm việc phải tuân thủ nghiêm ngặt quy định tại [AGENTS.md](AGENTS.md) và các quy tắc trong \`.claude/rules/\`.\n`;
        fs.writeFileSync(claudeMdPath, body, 'utf8');
        actions.push({ relative: 'CLAUDE.md', action: 'created' });
    } else {
        const existing = fs.readFileSync(claudeMdPath, 'utf8');
        if (!existing.includes(marker)) {
            const body = `${existing.trimEnd()}\n\n${marker}\nTất cả các phiên làm việc phải tuân thủ nghiêm ngặt quy định tại [AGENTS.md](AGENTS.md) và các quy tắc trong \`.claude/rules/\`.\n`;
            fs.writeFileSync(claudeMdPath, body, 'utf8');
            actions.push({ relative: 'CLAUDE.md', action: 'updated' });
        }
    }

    // 2. Sync root .mcp.json if missing (e.g. from .cursor/mcp.json)
    const rootMcpPath = path.join(root, '.mcp.json');
    if (!fs.existsSync(rootMcpPath)) {
        const cursorMcpPath = path.join(root, '.cursor', 'mcp.json');
        if (fs.existsSync(cursorMcpPath)) {
            try {
                const cursorMcp = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
                const claudeMcp = cursorMcp.mcpServers ? cursorMcp : { mcpServers: cursorMcp };
                fs.writeFileSync(rootMcpPath, `${JSON.stringify(claudeMcp, null, 2)}\n`, 'utf8');
                actions.push({ relative: '.mcp.json', action: 'created' });
            } catch {
                /* skip */
            }
        }
    }

    // 3. Ensure root .gitignore ignores .claude/session/ and .claude/settings.local.json
    const rootGitignore = path.join(root, '.gitignore');
    if (fs.existsSync(rootGitignore)) {
        let content = fs.readFileSync(rootGitignore, 'utf8');
        let updated = false;
        if (!content.includes('.claude/session')) {
            content = `${content.trimEnd()}\n.claude/session/\n`;
            updated = true;
        }
        if (!content.includes('.claude/settings.local.json')) {
            content = `${content.trimEnd()}\n.claude/settings.local.json\n`;
            updated = true;
        }
        if (updated) {
            fs.writeFileSync(rootGitignore, content, 'utf8');
            actions.push({ relative: '.gitignore', action: 'updated' });
        }
    }

    return actions;
}

/**
 * Merge one IDE tree's hook config, three-way.
 *
 * `pairs` is a list of `{ event, entries, blockId? }` so Cursor (flat `{hooks:{event:[…]}}`),
 * Antigravity (nested `{blockId:{event:[…]}}`), and Claude Code (`.claude/settings.json`)
 * go through the same ownership logic instead of separate merge implementations.
 *
 * @param {string} root consumer root
 * @param {string} treeKey `cursor` | `agents` | `claude`
 * @param {object} treeSpec host profile tree spec
 * @returns {{ actions: object[], report: object }}
 */
export function applyHostTree(root, treeKey, treeSpec, profileId) {
    void profileId;
    const actions = [];
    if (!treeSpec) return { actions, report: {} };

    actions.push(...ensureConsumerGuards(root, treeKey));
    actions.push(...ensureConsumerRules(root, treeKey));
    actions.push(...ensureConsumerSkills(root, treeKey));
    actions.push(...ensureSessionGitignore(root, treeKey));
    if (treeKey === 'claude') {
        actions.push(...ensureConsumerClaudeSupport(root));
    }

    const hooksPath = path.join(root, treeSpec.settingsJsonPath || treeSpec.hooksJsonPath || `.${treeKey}/hooks.json`);
    let hooksDoc = { version: 1, hooks: {} };
    if (fs.existsSync(hooksPath)) {
        try {
            hooksDoc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        } catch {
            hooksDoc = { version: 1, hooks: {} };
        }
    }

    // Seed consumer guard hooks if not present
    if (treeKey === 'cursor') {
        if (!hooksDoc.hooks) hooksDoc.hooks = {};
        if (!hooksDoc.hooks.preToolUse) hooksDoc.hooks.preToolUse = [];
        if (!hooksDoc.hooks.preToolUse.some((e) => entryCommand(e).includes('guard-write.py'))) {
            hooksDoc.hooks.preToolUse.unshift({
                command: '.cursor/hooks/guard-write.py',
                matcher: 'Write|StrReplace|Delete',
                failClosed: true,
            });
        }
        if (!hooksDoc.hooks.beforeShellExecution) hooksDoc.hooks.beforeShellExecution = [];
        if (!hooksDoc.hooks.beforeShellExecution.some((e) => entryCommand(e).includes('guard-shell.py'))) {
            hooksDoc.hooks.beforeShellExecution.unshift({
                command: '.cursor/hooks/guard-shell.py',
                failClosed: true,
            });
        }
    } else if (treeKey === 'agents') {
        /*
         * Portable form: no `bash`, so Windows can run it, and no `cd ..` guard because the Antigravity
         * tree is spawned with the consumer root as cwd. `python3` stays — `pre-tool-use.py` is a Python
         * file by design (it runs guard-write and guard-shell from one stdin read), and a command
         * literal cannot resolve a different interpreter name. Windows needs `python` on PATH or a
         * `python3` shim; that is a documented prerequisite, not something this string can fix.
         */
        const tracerCmd = 'python3 .agents/hooks/pre-tool-use.py';
        if (!hooksDoc['harness-tracer'] && !hooksDoc['consumer-guards']) {
            hooksDoc['harness-tracer'] = {
                PreToolUse: [
                    {
                        matcher: '*',
                        hooks: [
                            {
                                type: 'command',
                                command: tracerCmd,
                            },
                        ],
                    },
                ],
            };
        } else if (hooksDoc['harness-tracer']?.PreToolUse) {
            /*
             * Re-point a command **we** previously wrote, in any of its historical spellings. Matching
             * only the current one meant a consumer provisioned with the old `bash -lc '…'` form kept it
             * forever: the entry was found, the command did not match, and nothing was rewritten — the
             * exact drift `applyHostProfiles` exists to prevent.
             */
            const legacyTracers = new Set([
                'python3 .agents/hooks/pre-tool-use.py',
                "bash -lc '[ -f harness.config.json ] || cd ..; exec python3 .agents/hooks/pre-tool-use.py'",
            ]);
            for (const item of hooksDoc['harness-tracer'].PreToolUse) {
                for (const hook of item.hooks || []) {
                    if (legacyTracers.has(hook.command)) {
                        hook.command = tracerCmd;
                    }
                }
            }
        }
    }

    const state = readHostState(root);
    const treeState = state.hooks[treeKey] || {};
    const report = { added: [], updated: [], kept: [], overridden: [], pruned: [], missing: [] };

    /*
     * Cursor-style flat patch (`{hooks: {event: [...]}}`) — reconciled against the previous record
     * *even when the profile no longer declares one*.
     *
     * The `if (treeSpec.merge)` guard used to skip this entirely when a profile dropped its flat
     * hooks, which left every entry we had previously written in place forever. That is how
     * Antigravity's config kept a `hooks` block full of Cursor event names — a block AG never reads,
     * so the hooks in it silently never ran while the file looked fully wired.
     *
     * Passing an empty patch is the "remove everything we own here" operation: `mergeHooksDocument`
     * prunes our entries and leaves the consumer's alone.
     */
    const flatPatch = treeSpec.merge || {};
    const hadFlat = Object.keys(treeState.flat || {}).length > 0 || Object.keys(flatPatch).length > 0;
    if (hadFlat) {
        const r = mergeHooksDocument(hooksDoc, { hooks: flatPatch }, treeState.flat || {});
        hooksDoc = r.document;
        if (Object.keys(r.state).length) treeState.flat = r.state;
        else delete treeState.flat;
        for (const k of Object.keys(report)) report[k].push(...r.report[k]);
    }

    /*
     * Antigravity-style named blocks, one merge pass per block.
     *
     * Iterated over the union of what the profile declares and what we previously wrote, so removing
     * a block from the profile removes it from the consumer instead of stranding it.
     */
    const blockIds = new Set([
        ...Object.keys(treeSpec.agyMerge || {}),
        ...Object.keys(treeState.blocks || {}),
    ]);
    for (const blockId of blockIds) {
        const events = (treeSpec.agyMerge || {})[blockId] || {};
        const block = hooksDoc[blockId] || {};
        const r = mergeHooksDocument(
            { hooks: block },
            { hooks: events },
            (treeState.blocks || {})[blockId] || {},
        );
        if (Object.keys(r.document.hooks).length) hooksDoc = { ...hooksDoc, [blockId]: r.document.hooks };
        else delete hooksDoc[blockId];

        const blocks = { ...(treeState.blocks || {}) };
        if (Object.keys(r.state).length) blocks[blockId] = r.state;
        else delete blocks[blockId];
        treeState.blocks = blocks;
        for (const k of Object.keys(report)) report[k].push(...r.report[k]);
    }
    if (!Object.keys(treeState.blocks || {}).length) delete treeState.blocks;

    // A flat `hooks` object we emptied is dead weight in a config file; remove the key rather than
    // leaving `"hooks": {}` behind, which reads as "wired, just empty".
    if (hooksDoc.hooks && !Object.keys(hooksDoc.hooks).length) delete hooksDoc.hooks;

    state.hooks[treeKey] = treeState;
    if (!Object.keys(treeState).length) delete state.hooks[treeKey];
    writeJsonAtomic(hooksPath, hooksDoc);
    actions.push({ relative: path.relative(root, hooksPath), action: 'merge' });
    actions.push(writeHostState(root, state));

    if (treeSpec.sessionDir) {
        fs.mkdirSync(path.join(root, treeSpec.sessionDir), { recursive: true });
    }
    return { actions, report };
}

/**
 * Install the built host pack into a consumer.
 *
 * The pack is self-contained: a bundled dispatcher with no import outside `node:*`, plus the
 * stdlib-only `route-hook.py`. Nothing here points back at this checkout, which is what lets the
 * consumer keep its guards when the product repo is cleaned, moved or absent.
 *
 * Every file's sha256 is verified against `host-pack.json` after copying. A pack that installed
 * only partially would leave hooks that throw on every tool call — and because guards fail closed,
 * a truncated pack is an outage, not a degraded mode. Better to fail the provision.
 *
 * @param {string} root consumer root
 */
export function installHostPack(root) {
    const manifestPath = path.join(HOST_PACK_SRC, 'host-pack.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(
            `host pack not built at ${HOST_PACK_SRC} — run \`bun run build:host-pack\` before provisioning`,
        );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const destDir = path.join(root, HOST_PACK_REL);
    fs.mkdirSync(destDir, { recursive: true });

    const actions = [];
    const mismatched = [];
    for (const [name, expected] of Object.entries(manifest.files || {})) {
        const src = path.join(HOST_PACK_SRC, name);
        if (!fs.existsSync(src)) throw new Error(`host pack file missing in build: ${name}`);
        const bytes = fs.readFileSync(src);
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== expected) mismatched.push(name);
        fs.writeFileSync(path.join(destDir, name), bytes);
        actions.push({ relative: `${HOST_PACK_REL}/${name}`, action: 'write' });
    }
    if (mismatched.length) {
        throw new Error(`host pack checksum mismatch: ${mismatched.join(', ')}`);
    }
    for (const name of ['harness-hook.mjs', 'route-hook.py']) {
        try {
            fs.chmodSync(path.join(destDir, name), 0o755);
        } catch {
            /* best-effort on filesystems without exec bits */
        }
    }

    fs.writeFileSync(
        path.join(destDir, 'host-pack.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    actions.push({ relative: `${HOST_PACK_REL}/host-pack.json`, action: 'write' });

    // A pack that git will not commit does not survive a clone — and a clone without the pack is a
    // broken consumer, not a degraded one.
    actions.push(ensureHarnessGitignore(root));

    /*
     * Writing the rule is half the job: a file committed before the rule existed stays tracked, so the
     * next `writeSidecarEnv` shows up as a modification of this machine's URLs. The provision is where
     * the machine-local files are (re)written, so it is where the stale index entries are released.
     */
    const git = untrackIgnoredPaths(root);
    for (const relative of git.released) actions.push({ relative, action: 'untracked' });
    for (const relative of git.deleted) actions.push({ relative, action: 'untracked-deleted' });

    return { actions, manifest };
}

/**
 * A host install always names the port of the project it installs for. Refusing a missing one is
 * deliberate: the old `opts.observePort || 8792` is how a consumer silently received the first
 * project's port, and the resulting `sidecar.env`/`host-bootstrap.json` pointed at another stack.
 *
 * @param {unknown} observePort
 * @returns {number}
 */
function requireObservePort(observePort) {
    const port = Number.parseInt(String(observePort ?? ''), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
            `observePort is required for a host install (got ${String(observePort)}) — ` +
                'resolve it with claimObservePort() instead of defaulting to 8792',
        );
    }
    return port;
}

/**
 * @param {string} consumerRoot
 * @param {object} profile host profile JSON (e.g. cursor-superset)
 * @param {{ observePort: number, writeSidecar?: boolean, profileIds?: string[] }} opts
 */
export function applyHostProfile(consumerRoot, profile, opts = {}) {
    const root = path.resolve(consumerRoot);
    const port = requireObservePort(opts.observePort);
    const sidecarUrl = `http://127.0.0.1:${port}`;
    const actions = [];

    actions.push(...installHostPack(root).actions);

    if (opts.writeSidecar !== false) {
        const ids = opts.profileIds || [profile.id];
        actions.push(writeSidecarEnv(root, ids, port));
    }

    const bootstrap = {
        version: 1,
        profileId: profile.id,
        sidecarUrl,
        appliedAt: new Date().toISOString(),
        hostPack: packVersion(),
    };
    writeBootstrapState(root, {
        ...bootstrap,
        profileIds: [profile.id],
        profileId: profile.id,
    });
    actions.push({ relative: '.harness/host-bootstrap.json', action: 'write' });

    if (profile.cursor) {
        actions.push(...applyHostTree(root, 'cursor', profile.cursor, profile.id).actions);
    }
    if (profile.agents) {
        actions.push(...applyHostTree(root, 'agents', profile.agents, profile.id).actions);
    }
    if (profile.claude) {
        actions.push(...applyHostTree(root, 'claude', profile.claude, profile.id).actions);
    }

    return { actions, bootstrap };
}

/**
 * Full consumer host pack — one or more profiles (dual-ide = cursor + agents profiles).
 * @param {string} consumerRoot
 * @param {object[]} profiles
 * @param {{ observePort: number }} opts
 */
export function applyHostProfiles(consumerRoot, profiles, opts = {}) {
    if (!profiles?.length) {
        throw new Error('provision requires at least one host profile (full pack — no minimal tier)');
    }
    const root = path.resolve(consumerRoot);
    const port = requireObservePort(opts.observePort);
    const profileIds = profiles.map((p) => p.id);
    /*
     * The document bookkeeping lives in the host state next to the hook bookkeeping, and it survives
     * the hook merges below: they read the state before this section is filled in and write it back
     * through `writeHostState`, which carries `docs` through.
     */
    const state = readHostState(root);
    const docs = state.docs;
    const actions = [
        ...installHostPack(root).actions,
        writeSidecarEnv(root, profileIds, port),
        ...ensureConsumerWorkflowGuide(root, docs),
        ...ensureConsumerOnboarding(root, docs),
    ];
    state.docs = docs;
    actions.push(writeHostState(root, state));

    const sidecarUrl = `http://127.0.0.1:${port}`;
    const bootstrap = {
        version: 1,
        profileIds,
        sidecarUrl,
        appliedAt: new Date().toISOString(),
        hostPack: { version: packVersion(), ok: false, failures: [] },
    };
    actions.push({ relative: '.harness/host-bootstrap.json', action: 'write' });
    for (const profile of profiles) {
        if (profile.cursor) {
            actions.push(...applyHostTree(root, 'cursor', profile.cursor, profile.id).actions);
        }
        if (profile.agents) {
            actions.push(...applyHostTree(root, 'agents', profile.agents, profile.id).actions);
        }
        if (profile.claude) {
            actions.push(...applyHostTree(root, 'claude', profile.claude, profile.id).actions);
        }
    }

    /*
     * Verify the pack before declaring success. A guard that cannot run is not a degraded install,
     * it is an absent one — and because guards fail closed, an operator whose pack is broken would
     * discover it as an unexplained inability to run any command. Failing the provision surfaces it
     * while someone is watching.
     *
     * `verify: false` exists for callers that only exercise the merge/bookkeeping and would
     * otherwise pay ~0.7s per provision; production paths must leave it on.
     */
    if (opts.verify !== false) {
        const check = verifyHostPack(root);
        bootstrap.hostPack = { version: check.version, ok: check.ok, failures: check.failures ?? [] };
        writeBootstrapState(root, bootstrap);
        if (!check.ok) {
            throw new Error(
                `host pack verification failed for ${check.failures?.join(', ') || check.reason || 'unknown'} — the consumer would run with guards that cannot decide`,
            );
        }
        return { actions, bootstrap, verification: check };
    }

    writeBootstrapState(root, bootstrap);
    return { actions, bootstrap };
}

/**
 * Write the bootstrap record: this machine's stamp of what the provision applied.
 *
 * `host-bootstrap.json` is **machine-local** — the blanket ignore rules keep it out of git, like
 * `sidecar.env`, because everything it records (applied time, the checkout root, the last probe
 * result) is true of one workstation and misleading on another. It used to be admitted, which is how
 * a provision turned into a diff for every developer who cloned the repo.
 *
 * `appliedAt` is still kept stable across a re-provision of the same profile: the stamp answers "when
 * did this machine last *change* its profile", not "when did a command last run".
 *
 * The port stays out of it entirely: `sidecar.env` carries `HARNESS_TOKEN` and the stack port for
 * **this** machine, so a second developer cloning the repo must not inherit the first one's.
 * `sidecarUrl` therefore never reaches this file — see the destructure below.
 */
function writeBootstrapState(root, bootstrap) {
    const file = path.join(root, '.harness', 'host-bootstrap.json');
    let previous = null;
    try {
        previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        previous = null;
    }
    const sameProvision =
        previous &&
        previous.profileIds?.length === bootstrap.profileIds?.length &&
        (previous.profileIds || []).every((id) => (bootstrap.profileIds || []).includes(id)) &&
        previous.profileId === bootstrap.profileId;
    /*
     * `sidecarUrl` is dropped, not merely stabilised. It encodes the port THIS machine's stack listens
     * on; carrying it means the next clone inherits it and a teammate's agent talks to someone else's
     * Observatory. The port lives in `sidecar.env`, which is ignored for the same reason, and every
     * caller that needs it reads the URL from there.
     */
    const { sidecarUrl: _machineLocal, ...shared } = bootstrap;
    void _machineLocal;
    const next = {
        ...shared,
        appliedAt: sameProvision ? previous.appliedAt : bootstrap.appliedAt,
    };
    writeJsonAtomic(file, next);
    return { ...bootstrap, action: 'write' };
}

/** Version of the built host pack, for bootstrap metadata and outdated detection. */
export function packVersion() {
    try {
        const raw = fs.readFileSync(path.join(HOST_PACK_SRC, 'host-pack.json'), 'utf8');
        return JSON.parse(raw).version || null;
    } catch {
        return null;
    }
}

/** The built pack's manifest, or null when it has not been built. */
export function builtPackManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(HOST_PACK_SRC, 'host-pack.json'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Report what is actually installed in a consumer.
 *
 * "Installed" is not the same as "working", so this reports four independent things:
 *
 *   installed    — is there a pack, and does every file match the recorded checksum
 *   version      — installed vs the build, so drift after an upgrade is visible
 *   verification — the last recorded probe result from `.harness/host-bootstrap.json`
 *   trees        — which IDE trees we wired (from our own state file, not guessed)
 *
 * Kept as data so the CLI and the console can render the same answer.
 *
 * @param {string} root consumer root
 * @param {{ verify?: boolean }} [opts] run the probe now instead of reading the record
 */
export function hostPackStatus(root, opts = {}) {
    const packDir = path.join(root, HOST_PACK_REL);
    const installedManifestPath = path.join(packDir, 'host-pack.json');
    const build = builtPackManifest();
    const buildVersion = build?.version ?? null;

    if (!fs.existsSync(installedManifestPath)) {
        return {
            installed: false,
            root,
            packDir,
            buildVersion,
            reason: 'no host pack installed — run: harness host-pack refresh <consumer>',
        };
    }

    const manifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'));
    const corrupt = [];
    for (const [name, expected] of Object.entries(manifest.files || {})) {
        const file = path.join(packDir, name);
        if (!fs.existsSync(file)) {
            corrupt.push(`${name} (missing)`);
            continue;
        }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (actual !== expected) corrupt.push(`${name} (checksum)`);
    }

    const state = readHostState(root);
    const trees = Object.entries(state.hooks).map(([treeKey, treeState]) => {
        const flat = treeState.flat ? Object.values(treeState.flat).flatMap((e) => Object.keys(e)) : [];
        const blocks = Object.values(treeState.blocks || {}).flatMap((b) =>
            Object.values(b).flatMap((e) => Object.keys(e)),
        );
        const overridden = [...Object.values(treeState.flat || {}), ...Object.values(treeState.blocks || {}).flatMap((b) => Object.values(b))]
            .flatMap((e) => Object.values(e))
            .filter((rec) => rec?.overridden)
            .map((rec) => rec.name)
            .filter(Boolean);
        return { tree: treeKey, hooks: flat.length + blocks.length, overridden };
    });

    const bootstrapPath = path.join(root, '.harness', 'host-bootstrap.json');
    let bootstrap = null;
    try {
        bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    } catch {
        bootstrap = null;
    }

    return {
        installed: true,
        root,
        packDir,
        version: manifest.version,
        buildVersion,
        outdated: buildVersion != null && manifest.version !== buildVersion,
        corrupt,
        ok: corrupt.length === 0,
        profileIds: bootstrap?.profileIds ?? bootstrap?.profileId ?? [],
        verification: opts.verify ? verifyHostPack(root) : (bootstrap?.hostPack ?? null),
        trees,
    };
}

/**
 * Remove our hook entries from one IDE tree.
 *
 * Prunes only entries this repo recorded **and** that nobody edited — `mergeHooksDocument` with an
 * empty patch is exactly that operation, and it refuses to touch a line the consumer has taken over.
 * The consumer's own guards (their `guard-write.py`, their matchers) are never candidates.
 *
 * @param {string} root consumer root
 * @param {string} treeKey `cursor` | `agents`
 */
export function removeHostTree(root, treeKey) {
    const state = readHostState(root);
    const treeState = state.hooks[treeKey];
    if (!treeState) {
        /*
         * Nothing wired — but the *profile id* may still be recorded (an earlier removal that predates
         * the bookkeeping). Clean that up too, so the command is idempotent and the bootstrap stops
         * claiming a tree that is not there.
         */
        const stale = findProfileIdForTree(treeKey);
        const dropped = stale ? dropProfileFromBootstrap(root, stale) : false;
        return { removed: [], hooksPath: null, profileId: dropped ? stale : null };
    }

    const profile = treeState.hooksJsonPath
        ? { hooksJsonPath: treeState.hooksJsonPath }
        : findTreeSpec(root, treeKey);
    /*
     * A tree may carry its hooks in a settings file rather than a `hooks.json` (claude does), so the
     * settings path is the second place to look — without it removal resolved `.claude/hooks.json`,
     * a file that does not exist, and reported "nothing to remove" while our entries stayed wired.
     */
    const hooksPath = path.join(
        root,
        treeState.hooksJsonPath || profile?.settingsJsonPath || profile?.hooksJsonPath || `.${treeKey}/hooks.json`,
    );
    if (!fs.existsSync(hooksPath)) return { removed: [], hooksPath };

    let hooksDoc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const report = { pruned: [] };

    if (treeState.flat) {
        const r = mergeHooksDocument(hooksDoc, { hooks: {} }, treeState.flat);
        hooksDoc = r.document;
        report.pruned.push(...r.report.pruned);
    }
    for (const [blockId, blockState] of Object.entries(treeState.blocks || {})) {
        const r = mergeHooksDocument({ hooks: hooksDoc[blockId] || {} }, { hooks: {} }, blockState);
        hooksDoc = { ...hooksDoc, [blockId]: r.document.hooks };
        report.pruned.push(...r.report.pruned);
    }

    writeJsonAtomic(hooksPath, hooksDoc);
    delete state.hooks[treeKey];
    writeHostState(root, state);

    /*
     * The bootstrap file is what an operator reads to answer "which profiles are wired here". Leaving a
     * profile id behind after its tree was unwired makes it disagree with the state file, and the next
     * provision then reinstates a tree nobody asked for.
     */
    const profileId = findProfileIdForTree(treeKey);
    const dropped = profileId ? dropProfileFromBootstrap(root, profileId) : false;
    return { removed: report.pruned, hooksPath, profileId: dropped ? profileId : null };
}

/** Which shipped profile provides this tree, so bookkeeping can name it. */
function findProfileIdForTree(treeKey) {
    const profilesDir = path.resolve(GENERIC_PKG, '../../../profiles');
    for (const profileId of listHostProfileIds(profilesDir)) {
        const hp = loadHostProfile(profilesDir, profileId);
        if (hp?.[treeKey]) return profileId;
    }
    return null;
}

/** Remove one profile id from `.harness/host-bootstrap.json`; true when it was there. */
function dropProfileFromBootstrap(root, profileId) {
    const file = path.join(root, '.harness', 'host-bootstrap.json');
    let bootstrap;
    try {
        bootstrap = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
    const ids = Array.isArray(bootstrap.profileIds)
        ? bootstrap.profileIds
        : bootstrap.profileId
          ? [bootstrap.profileId]
          : [];
    if (!ids.includes(profileId)) return false;
    const next = ids.filter((id) => id !== profileId);
    bootstrap.profileIds = next;
    if (bootstrap.profileId && !next.includes(bootstrap.profileId)) delete bootstrap.profileId;
    writeJsonAtomic(file, bootstrap);
    return true;
}

/**
 * Find the tree spec for a tree key by scanning the shipped host profiles.
 *
 * The path is the repo's `profiles/`, three levels up from the host-generic source directory. It used
 * to be two (`packages/harness-host-generic/profiles`), which does not exist — so this always returned
 * null and removal fell back to `.<tree>/hooks.json` for every tree that stores its hooks in a settings
 * file. Removing the claude tree therefore reported "nothing to remove" while its entries stayed wired.
 */
function findTreeSpec(root, treeKey) {
    const profilesDir = path.resolve(GENERIC_PKG, '../../../profiles');
    for (const profileId of listHostProfileIds(profilesDir)) {
        const hp = loadHostProfile(profilesDir, profileId);
        if (hp?.[treeKey]) return hp[treeKey];
    }
    void root;
    return null;
}

/**
 * Apply one extra host profile to a consumer, extending the recorded set.
 *
 * The profile must exist as data (`profiles/host/<id>.json`). There is no built-in list of IDEs to
 * choose from on purpose: a new IDE is a profile descriptor, and inventing one here would mean
 * guessing an IDE's hook vocabulary — which is exactly the kind of guess that produces a guard that
 * never runs.
 *
 * @param {string} root consumer root
 * @param {string} profileId e.g. `cursor-superset`
 * @param {string} profilesDir directory holding `host/<id>.json`
 * @param {{ observePort?: number }} [opts]
 */
export function addHostProfile(root, profileId, profilesDir, opts = {}) {
    const hp = loadHostProfile(profilesDir, profileId);
    if (!hp) {
        const known = listHostProfileIds(profilesDir).join(', ');
        throw new Error(`unknown host profile "${profileId}" — available: ${known}`);
    }

    /*
     * Wire the profile *and* make sure the pack it points at exists. `add-ide` on a consumer that
     * was never provisioned is a reasonable thing to ask for, and answering it with hooks that
     * reference a missing bundle would leave a consumer that fails on every tool call.
     * `installHostPack` is idempotent, so this costs nothing when the pack is already there.
     */
    const actions = [...installHostPack(root).actions];

    /*
     * The operator docs go with it: `add-ide` on a repo nobody provisioned is exactly the case that
     * has no checklist yet, and the three documents are the same for every host tree.
     */
    const state = readHostState(root);
    const docs = state.docs;
    actions.push(...ensureConsumerWorkflowGuide(root, docs), ...ensureConsumerOnboarding(root, docs));
    state.docs = docs;
    actions.push(writeHostState(root, state));

    const bootstrapPath = path.join(root, '.harness', 'host-bootstrap.json');
    let bootstrap = {};
    try {
        bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
    } catch {
        bootstrap = {};
    }
    const profileIds = new Set(
        Array.isArray(bootstrap.profileIds)
            ? bootstrap.profileIds
            : bootstrap.profileId
              ? [bootstrap.profileId]
              : [],
    );
    profileIds.add(profileId);

    for (const treeKey of ['cursor', 'agents', 'claude']) {
        if (!hp[treeKey]) continue;
        actions.push(...applyHostTree(root, treeKey, hp[treeKey], profileId).actions);
    }

    bootstrap = {
        ...bootstrap,
        version: 1,
        profileIds: [...profileIds],
        appliedAt: new Date().toISOString(),
        hostPack: { version: packVersion(), ok: false, failures: [] },
    };
    writeJsonAtomic(bootstrapPath, bootstrap);
    actions.push({ relative: '.harness/host-bootstrap.json', action: 'write' });

    const check = verifyHostPack(root);
    bootstrap.hostPack = { version: check.version, ok: check.ok, failures: check.failures ?? [] };
    writeBootstrapState(root, bootstrap);
    if (!check.ok) {
        throw new Error(`host pack verification failed for ${check.failures?.join(', ')}`);
    }
    void opts;
    return { actions, profileIds: [...profileIds], verification: check };
}

/**
 * Hooks probed by the install self-check, with a benign payload each.
 *
 * A guard that never got wired behaves exactly like a guard that approved everything, so
 * "installed" is not the same as "working". Each hook is run once and must answer with a
 * well-formed decision. The check deliberately does not care *which* decision it is — `deny` is a
 * perfectly good answer for a write gate with no preflight — only that the hook ran and decided.
 */
const PROBE_PAYLOADS = {
    'guard-shell': { command: 'true' },
    'guard-brain': { tool_name: 'Read' },
    preflight: { prompt: 'install self-check', conversation_id: 'host-pack-verify' },
    route: {},
    'gap-tracker': { tool_name: 'Read', tool_input: { path: 'README.md' } },
    'post-tool-hint': { tool_name: 'Read' },
    'pre-compact': { conversation_id: 'host-pack-verify' },
};

/**
 * Run every installed hook once and confirm it produces a decision.
 *
 * Probes run in a throwaway working directory, not in the consumer. Two reasons: the hooks write
 * session artifacts (`.eso-preflight.json`, gap closures, trace lines) which would otherwise be
 * left behind for a turn that never happened, and `findRepoRoot` walking up from a temp dir finds
 * no consumer policy — which is the more interesting case to prove, because it means the hook
 * resolves its own dependencies rather than depending on the repo it happens to sit in.
 *
 * @param {string} root consumer root
 * @param {{ timeoutMs?: number }} [opts]
 */
export function verifyHostPack(root, opts = {}) {
    const packDir = path.join(root, HOST_PACK_REL);
    const manifestPath = path.join(packDir, 'host-pack.json');
    if (!fs.existsSync(manifestPath)) {
        return { ok: false, version: null, reason: 'host pack not installed', hooks: [] };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = path.join(packDir, manifest.entry || 'harness-hook.mjs');
    if (!fs.existsSync(entry)) {
        return { ok: false, version: manifest.version, reason: `missing ${manifest.entry}`, hooks: [] };
    }

    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verify-'));
    const hooks = [];
    try {
        for (const [hook, payload] of Object.entries(PROBE_PAYLOADS)) {
            const proc = spawnSync('node', [entry, '--hook', hook, '--tree', 'cursor'], {
                input: `${JSON.stringify(payload)}\n`,
                encoding: 'utf8',
                cwd: probeRoot,
                timeout: opts.timeoutMs ?? 20000,
                env: { ...process.env, HARNESS_TREE: 'cursor' },
            });
            const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
            let json = null;
            try {
                json = line ? JSON.parse(line) : null;
            } catch {
                json = null;
            }
            const decided =
                !!json && (typeof json.permission === 'string' || typeof json.decision === 'string' || typeof json.hookSpecificOutput === 'object');
            hooks.push({
                hook,
                ok: decided,
                decision: json?.permission ?? json?.decision ?? (json?.hookSpecificOutput ? 'allow' : null),
                // A hook that exits non-zero without a decision is the exact silent-failure this
                // check exists to catch.
                status: proc.status,
                error: decided ? null : String(proc.stderr || '').trim().slice(0, 300) || 'no decision emitted',
            });
        }
    } finally {
        fs.rmSync(probeRoot, { recursive: true, force: true });
    }

    const failed = hooks.filter((h) => !h.ok);
    return {
        ok: failed.length === 0,
        version: manifest.version,
        verifiedAt: new Date().toISOString(),
        hooks,
        failures: failed.map((f) => f.hook),
    };
}

export function loadHostProfile(profilesDir, profileId) {
    const fp = path.join(profilesDir, 'host', `${profileId}.json`);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

export function listHostProfileIds(profilesDir) {
    const dir = path.join(profilesDir, 'host');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
}
