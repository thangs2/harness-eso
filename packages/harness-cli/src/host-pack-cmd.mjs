#!/usr/bin/env node
/**
 * `harness host-pack <status|refresh|sync-guards|add-ide|remove-ide>` — manage the consumer's installed pack.
 *
 * Why these four and not a generic "config" verb: the pack is a **build output** copied into the
 * consumer, its wiring in `hooks.json` is co-owned with the consumer, and its health is a runtime
 * property (does the hook actually decide?). Each verb maps to one of those.
 *
 *   status       what is installed, whether it matches the build, and whether it runs
 *   refresh      reinstall + reconcile every wired IDE tree (the upgrade path)
 *   sync-guards  replace the consumer's copied Python guards with the shipped ones (G-17)
 *   add-ide      apply one more host profile descriptor
 *   remove-ide   unwire one tree, leaving the consumer's own hooks alone
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    addHostProfile,
    applyHostTree,
    hostPackStatus,
    installHostPack,
    listHostProfileIds,
    loadHostProfile,
    packVersion,
    removeHostTree,
    syncConsumerGuards,
    verifyHostPack,
} from '@mu/harness-foundation/host-install';
import { checkGuardFreshness } from '@mu/harness-eso-core';
import { loadWorkspace } from '@mu/harness-foundation/workspace';
import { ESO_ROOT } from './workspace-env.mjs';

function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.join(ESO_ROOT, 'profiles');
}

function die(msg) {
    console.error(`host-pack: ${msg}`);
    process.exit(1);
}

/**
 * Resolve the consumer to operate on.
 *
 * Accepts an explicit path or `--project <id>` for a project the workspace already knows — the same
 * two ways `observatory` locates a consumer, so an operator does not have to remember which verb
 * wants which.
 */
function resolveConsumer(opts, positional) {
    /*
     * A bare word is a **project id**, not a relative path.
     *
     * `path.resolve("atrievefin")` produced `<cwd>/atrievefin` — a directory that does not exist — and the
     * command then reported "nothing to sync" against a consumer that was right there in the registry.
     * Atrievefin, 2026-10-23. An argument that looks like a path (`./x`, `/x`, `../x`) still is one.
     */
    if (positional && /[\\/]/.test(positional)) return path.resolve(positional);
    if (positional) {
        const ws = loadWorkspace();
        const row = (ws.projects || []).find((p) => p.id === positional);
        if (row) return path.resolve(row.rootHost || row.root);
        if (fs.existsSync(path.resolve(positional))) return path.resolve(positional);
        die(`unknown project "${positional}" — harnessctl configure list`);
    }
    if (opts.project) {
        const ws = loadWorkspace();
        const row = ws.projects.find((p) => p.id === opts.project);
        if (!row) die(`unknown project "${opts.project}" — harnessctl configure list`);
        return path.resolve(row.rootHost || row.root);
    }
    die('needs a consumer path or --project <id>');
    return '';
}

function parse(argv) {
    const opts = { project: null, ide: null, profile: null, verify: false, json: false, force: false, dryRun: false };
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--project') opts.project = argv[++i];
        else if (a === '--ide') opts.ide = argv[++i];
        else if (a === '--profile') opts.profile = argv[++i];
        else if (a === '--verify') opts.verify = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('-')) die(`unknown flag: ${a}`);
        else positional.push(a);
    }
    return { opts, positional };
}

function readBootstrap(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, '.harness', 'host-bootstrap.json'), 'utf8'));
    } catch {
        return {};
    }
}

function profileIdsOf(bootstrap) {
    if (Array.isArray(bootstrap.profileIds)) return bootstrap.profileIds;
    return bootstrap.profileId ? [bootstrap.profileId] : [];
}

function printStatus(status) {
    if (!status.installed) {
        console.log('host-pack: NOT INSTALLED');
        console.log(`  ${status.reason}`);
        return;
    }
    console.log(`host-pack  ${status.root}`);
    console.log(
        `  version      ${status.version}${status.outdated ? `  ← outdated (build ${status.buildVersion})` : ''}`,
    );
    console.log(`  integrity    ${status.ok ? 'ok' : `FAILED — ${status.corrupt.join(', ')}`}`);
    const v = status.verification;
    if (v) {
        console.log(
            `  verification ${v.ok ? 'ok' : `FAILED — ${(v.failures || []).join(', ')}`}${
                v.verifiedAt ? `  (${v.verifiedAt})` : ''
            }`,
        );
    } else {
        console.log('  verification not recorded — run: harness host-pack refresh <consumer>');
    }
    if (!status.trees.length) {
        // Worth calling out: a pack that nothing invokes passes every other check.
        console.log('  IDE trees    none wired — the pack is installed but nothing runs it');
    }
    for (const t of status.trees) {
        const over = t.overridden.length ? `  (consumer-overridden: ${t.overridden.join(', ')})` : '';
        console.log(`  IDE tree     ${t.tree}: ${t.hooks} hook entries${over}`);
    }
}

function cmdStatus({ opts, positional }) {
    const root = resolveConsumer(opts, positional[0]);
    const status = hostPackStatus(root, { verify: opts.verify });
    if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
    } else {
        printStatus(status);
    }
    // Non-zero exit so this works from a script or health probe: "present" alone is not healthy.
    if (!status.installed || !status.ok || status.verification?.ok === false) process.exit(1);
}

/**
 * Reinstall the pack and re-reconcile every IDE tree that is already wired.
 *
 * This is the upgrade path, and it is deliberately **not** `init profile` again: that re-runs project
 * creation and the policy merge, so an operator who only wants the new hook build would be
 * re-deciding provisioning questions. Refresh touches the pack and the hook wiring, nothing else.
 */
function cmdRefresh({ opts, positional }) {
    const root = resolveConsumer(opts, positional[0]);
    const before = hostPackStatus(root);
    const installed = installHostPack(root);

    const bootstrap = readBootstrap(root);
    const profileIds = profileIdsOf(bootstrap);
    const actions = [...installed.actions];
    const skippedProfiles = [];

    for (const profileId of profileIds) {
        const hp = loadHostProfile(profilesDir(), profileId);
        if (!hp) {
            // A profile recorded at provision time but no longer shipped. Report it rather than
            // silently refreshing a consumer into a set of hooks nobody declared.
            skippedProfiles.push(profileId);
            continue;
        }
        for (const treeKey of ['cursor', 'agents']) {
            if (!hp[treeKey]) continue;
            actions.push(...applyHostTree(root, treeKey, hp[treeKey], profileId).actions);
        }
    }

    const check = verifyHostPack(root);
    console.log(`host-pack refresh  ${root}`);
    console.log(`  version      ${before.version ?? '(none)'} → ${packVersion()}`);
    console.log(`  files        ${installed.actions.length} written`);
    console.log(`  trees        ${profileIds.length ? profileIds.join(', ') : '(none recorded)'}`);
    if (skippedProfiles.length) {
        console.log(`  ! not shipped ${skippedProfiles.join(', ')} — their trees were left as they were`);
    }
    console.log(`  verification ${check.ok ? 'ok' : `FAILED — ${(check.failures || []).join(', ')}`}`);
    if (opts.json) console.log(JSON.stringify({ actions, verification: check }, null, 2));
    if (!check.ok) die('verification failed; the consumer would run with guards that cannot decide');
}

/**
 * `sync-guards` — replace the consumer's copied guard files with the shipped ones (G-17).
 *
 * This exists because `provision` cannot do it: `ensureConsumerGuards` is create-if-missing so an
 * operator's edit is never silently reverted, and that left no upgrade path at all. atrievefin ran a
 * pre-fix `guard-write.py` through a successful `./provision.sh --force`. The command is explicit,
 * backs up before writing, skips files that look operator-owned, and reports what it did per file.
 */
function cmdSyncGuards({ opts, positional }) {
    const root = resolveConsumer(opts, positional[0]);
    const res = syncConsumerGuards(root, {
        treeKeys: opts.ide ? [opts.ide] : undefined,
        force: opts.force === true,
        dryRun: opts.dryRun === true,
    });
    const { actions, templatesDir } = res;
    console.log(`host-pack sync-guards  ${root}`);
    console.log(`  templates    ${templatesDir}`);
    if (!actions.length) console.log('  nothing to sync — no IDE tree with a hooks directory');
    for (const a of actions) {
        const tail = a.backup ? `  (backup ${a.backup})` : a.reason ? `  — ${a.reason}` : '';
        console.log(`  ${a.action.padEnd(8)} ${a.file}${tail}`);
    }
    const failed = actions.filter((a) => a.action === 'skipped');
    if (opts.json) console.log(JSON.stringify(res, null, 2));

    /*
     * Re-verify through the same reader H1 uses. A guard command that says "updated" and a conformance
     * check that still says stale would be two answers to one question, and this repo has been bitten by
     * that before (G-08's two resolvers).
     */
    const freshness = checkGuardFreshness(root);
    console.log(`  guards       ${freshness.status} — ${freshness.detail}`);
    if (opts.dryRun) {
        console.log('  (dry-run — nothing written)');
        return;
    }
    if (freshness.status === 'stale' || freshness.status === 'not-applied') {
        die(`guards are still ${freshness.status} after sync${failed.length ? ` (${failed.length} skipped)` : ''}`);
    }
}

function cmdAddIde({ opts, positional }) {
    const root = resolveConsumer(opts, positional[0]);
    const profileId = opts.profile || opts.ide;
    if (!profileId) {
        die(
            `needs --profile <id>. Available: ${listHostProfileIds(profilesDir()).join(', ')}\n` +
                '  A new IDE is a data descriptor (profiles/host/<id>.json). There is no built-in list\n' +
                "  on purpose: guessing an IDE's hook vocabulary produces a guard that never runs.",
        );
    }
    const res = addHostProfile(root, profileId, profilesDir());
    console.log(`host-pack add-ide  ${root}`);
    console.log(`  profile      ${profileId}`);
    console.log(`  profiles     ${res.profileIds.join(', ')}`);
    console.log(`  verification ${res.verification.ok ? 'ok' : 'FAILED'}`);
}

function cmdRemoveIde({ opts, positional }) {
    const root = resolveConsumer(opts, positional[0]);
    const tree = opts.ide;
    /*
     * Any tree that can be provisioned can be unwired: the state file knows the hook shape, and the
     * tree spec is data. Restricting this to two names made `claude` un-removable, which is how a
     * consumer keeps a hook config nobody asked for after an experiment.
     */
    if (!tree || !/^[a-z][a-z0-9-]*$/.test(tree)) die('needs --ide <tree>, e.g. cursor|agents|claude');

    const res = removeHostTree(root, tree);
    console.log(`host-pack remove-ide  ${root}`);
    console.log(`  tree         ${tree}`);
    console.log(
        `  removed      ${res.removed.length ? res.removed.join(', ') : '(nothing of ours was wired)'}`,
    );
    console.log("  kept         the consumer's own hook entries are untouched");
}

export function runHostPack(subcommand, argv) {
    const parsed = parse(argv);
    switch (subcommand) {
        case 'status':
            return cmdStatus(parsed);
        case 'refresh':
            return cmdRefresh(parsed);
        case 'sync-guards':
            return cmdSyncGuards(parsed);
        case 'add-ide':
            return cmdAddIde(parsed);
        case 'remove-ide':
            return cmdRemoveIde(parsed);
        default:
            die(`unknown subcommand "${subcommand}" (try: status refresh sync-guards add-ide remove-ide)`);
            return undefined;
    }
}
