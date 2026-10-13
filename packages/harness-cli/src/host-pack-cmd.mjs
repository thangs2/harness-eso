#!/usr/bin/env node
/**
 * `harness host-pack <status|refresh|add-ide|remove-ide>` — manage the consumer's installed pack.
 *
 * Why these four and not a generic "config" verb: the pack is a **build output** copied into the
 * consumer, its wiring in `hooks.json` is co-owned with the consumer, and its health is a runtime
 * property (does the hook actually decide?). Each verb maps to one of those.
 *
 *   status       what is installed, whether it matches the build, and whether it runs
 *   refresh      reinstall + reconcile every wired IDE tree (the upgrade path)
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
    verifyHostPack,
} from '@mu/harness-foundation/host-install';
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
    if (positional) return path.resolve(positional);
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
    const opts = { project: null, ide: null, profile: null, verify: false, json: false };
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--project') opts.project = argv[++i];
        else if (a === '--ide') opts.ide = argv[++i];
        else if (a === '--profile') opts.profile = argv[++i];
        else if (a === '--verify') opts.verify = true;
        else if (a === '--json') opts.json = true;
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
 * This is the upgrade path, and it is deliberately **not** `init profile` again: that re-runs tenant
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
    if (!tree || !['cursor', 'agents'].includes(tree)) die('needs --ide cursor|agents');

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
        case 'add-ide':
            return cmdAddIde(parsed);
        case 'remove-ide':
            return cmdRemoveIde(parsed);
        default:
            die(`unknown subcommand "${subcommand}" (try: status refresh add-ide remove-ide)`);
            return undefined;
    }
}
