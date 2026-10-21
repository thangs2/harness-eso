#!/usr/bin/env node
/**
 * Build an isolated snapshot for a pilot run.
 *
 * Why this exists
 * ---------------
 * Replaying a merged ticket is only meaningful if the answer is not in the checkout. A normal clone
 * at the parent commit still carries the answer: the working branch, tags and remote refs all point
 * at later commits, so `git log`, `git branch -a` or `git show <sha>` hand the agent the diff it is
 * supposed to write. Deleting the files is not enough — the objects are still reachable.
 *
 * This script clones, detaches at the requested commit, deletes every other ref, expires the reflog
 * and prunes. It then ASSERTS the forbidden commit is unreachable, because a silent leak invalidates
 * every run that uses the snapshot.
 *
 * Usage
 *   node scripts/pilot-snapshot.mjs --repo ~/Workspaces/baplatform --commit <parent> --out /tmp/pilot-A --forbid <answer>
 *   node scripts/pilot-snapshot.mjs --repo . --commit HEAD --out /tmp/pilot-A --depth 50
 *
 * Exit codes: 0 ok, 1 error, 2 leak detected (snapshot left in place for inspection).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
    const out = { repo: null, commit: 'HEAD', out: null, forbid: null, depth: 0, force: false, quiet: false };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === '--repo') out.repo = v();
        else if (a === '--commit') out.commit = v();
        else if (a === '--out') out.out = v();
        else if (a === '--forbid') out.forbid = v();
        else if (a === '--depth') out.depth = Number(v());
        else if (a === '--force') out.force = true;
        else if (a === '--strip-eso') out.stripEso = true;
        else if (a === '--quiet') out.quiet = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function git(args, cwd, { allowFail = false } = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 && !allowFail) {
        throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
    return r;
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help || !opts.repo || !opts.out) {
        console.log('usage: node scripts/pilot-snapshot.mjs --repo <path> [--commit <sha>] --out <dir> [--forbid <sha>] [--depth N] [--strip-eso] [--force]');
        process.exit(opts.help ? 0 : 2);
    }
    const repo = path.resolve(opts.repo);
    const out = path.resolve(opts.out);

    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git checkout`);
    const sha = git(['rev-parse', opts.commit], repo).stdout.trim();
    const info = git(['show', '-s', '--format=%h %ad %s', '--date=short', sha], repo).stdout.trim();

    if (fs.existsSync(out) && fs.readdirSync(out).length) {
        if (!opts.force) throw new Error(`${out} is not empty (use --force to replace it)`);
        fs.rmSync(out, { recursive: true, force: true });
    }
    fs.mkdirSync(out, { recursive: true });

    // 1. Clone. A shallow clone is faster but loses blame history; depth 0 keeps the project's real past.
    const cloneArgs = ['clone', '--no-local', '--quiet'];
    if (opts.depth > 0) cloneArgs.push('--depth', String(opts.depth));
    cloneArgs.push(repo, out);
    git(cloneArgs, path.dirname(out));

    // A shallow clone may not contain an arbitrary commit: fetch it explicitly.
    const hasCommit = git(['cat-file', '-e', `${sha}^{commit}`], out, { allowFail: true }).status === 0;
    if (!hasCommit) git(['fetch', '--quiet', '--depth', '1', 'origin', sha], out);

    // 2. Detach at the target, then remove every other way to reach a later commit.
    git(['checkout', '--quiet', '--detach', sha], out);
    git(['remote', 'remove', 'origin'], out, { allowFail: true });
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'], out)
        .stdout.split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const ref of refs) git(['update-ref', '-d', ref], out, { allowFail: true });

    // 3. Drop the reflog and unreachable objects — a ref deletion alone leaves the commit in the object store.
    git(['reflog', 'expire', '--expire=now', '--all'], out, { allowFail: true });
    git(['gc', '--prune=now', '--quiet'], out, { allowFail: true });

    // 3b. Optional: remove ESO wiring so the copy is a genuine native baseline. Several consumers
    // TRACK `.cursor/hooks.json` and the guard scripts, so a plain clone still calls the host pack.
    let stripped = [];
    if (opts.stripEso) {
        const remove = [
            'harness.config.json',
            '.harness/host-pack',
            '.harness/decision-policy.json',
            '.harness/host-install-state.json',
            '.harness/host-bootstrap.json',
            '.harness/integrations.json',
            '.cursor/hooks',
            '.agents/hooks',
            '.claude/hooks',
        ];
        for (const rel of remove) {
            const abs = path.join(out, rel);
            if (!fs.existsSync(abs)) continue;
            fs.rmSync(abs, { recursive: true, force: true });
            stripped.push(rel);
        }
        for (const rel of ['.cursor/hooks.json', '.agents/hooks.json', '.claude/settings.json']) {
            const abs = path.join(out, rel);
            if (!fs.existsSync(abs)) continue;
            /*
             * Each host has its own empty shape. Cursor reads `{version, hooks}`; Antigravity reads a
             * bare map of named hook blocks, so writing Cursor's shape there invents blocks named
             * `version` and `hooks`. Claude's settings file is JSON with a `hooks` key.
             */
            const empty = rel === '.cursor/hooks.json' ? '{"version":1,"hooks":{}}\n' : '{}\n';
            fs.writeFileSync(abs, empty);
            stripped.push(`${rel} (emptied)`);
        }
        if (stripped.length) {
            git(['add', '-A'], out);
            git(['-c', 'user.name=pilot', '-c', 'user.email=pilot@local', 'commit', '--quiet', '-m', 'pilot: native baseline (ESO wiring removed)'], out);
        }
    }

    // 4. Prove the state instead of assuming it.
    const head = git(['rev-parse', 'HEAD'], out).stdout.trim();
    // `--strip-eso` commits the removal, so HEAD intentionally moves one commit past the target.
    if (head !== sha && !opts.stripEso) throw new Error(`HEAD is ${head}, expected ${sha}`);
    const dirty = git(['status', '--porcelain'], out).stdout.trim();
    if (dirty) throw new Error(`snapshot is not clean:\n${dirty}`);

    let leak = null;
    if (opts.forbid) {
        const forbidden = git(['rev-parse', opts.forbid], repo).stdout.trim();
        for (const probe of [`${forbidden}^{commit}`, forbidden]) {
            if (git(['cat-file', '-e', probe], out, { allowFail: true }).status === 0) {
                leak = `object ${forbidden} is still reachable in the snapshot`;
                break;
            }
        }
        const reachable = git(['rev-list', '--all'], out).stdout;
        if (!leak && reachable.split('\n').includes(forbidden)) leak = `commit ${forbidden} is reachable from a ref`;
    }

    const size = spawnSync('du', ['-sh', path.join(out, '.git')], { encoding: 'utf8' }).stdout.trim().split('\t')[0];
    if (!opts.quiet) {
        console.log(`snapshot ${out}`);
        console.log(`  commit  ${info}`);
        console.log(`  head    ${head}`);
        console.log(`  refs    ${refs.length} removed (history before the commit is kept)`);
        console.log(`  git     ${size}`);
        console.log(`  forbid  ${opts.forbid ? (leak ? 'LEAK' : 'unreachable') : 'not checked'}`);
        console.log(`  strip   ${opts.stripEso ? `${stripped.length} ESO path(s) removed` : 'no'}`);
    }
    if (leak) {
        console.error(`pilot-snapshot: LEAK — ${leak}`);
        process.exit(2);
    }
}

try {
    main();
} catch (err) {
    console.error(`pilot-snapshot: ${err.message}`);
    process.exit(1);
}
