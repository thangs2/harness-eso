#!/usr/bin/env node
/**
 * Reset a pilot snapshot between runs.
 *
 * Two arms cannot be reset the same way:
 *   - the native arm (A) is a clean checkout, so `git reset --hard` + `git clean -fd` restores it;
 *   - the ESO arm (B) has PROVISIONED files that are either tracked-but-modified
 *     (`.agents/hooks.json`, `.cursor/hooks.json`) or untracked (`.harness/host-pack`,
 *     `harness.config.json`). A blanket reset would delete the treatment, so B is reset surgically:
 *     only the run's output file is removed and the hook wiring is verified afterwards.
 *
 * Usage
 *   node scripts/pilot-reset.mjs --a /tmp/pilot-A --b /tmp/pilot-B
 *   node scripts/pilot-reset.mjs --a /tmp/pilot-A --b /tmp/pilot-B --output docs/PILOT-CHECK.md
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
    const out = { a: null, b: null, output: 'docs/PILOT-CHECK.md', quiet: false };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === '--a') out.a = v();
        else if (a === '--b') out.b = v();
        else if (a === '--output') out.output = v();
        else if (a === '--quiet') out.quiet = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function git(args, cwd, { allowFail = false } = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
    return r;
}

function status(dir) {
    return git(['status', '--porcelain'], dir).stdout.trim();
}

function requireDir(dir, label) {
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`${label}: ${dir} is not a git checkout`);
}

function resetNative(dir) {
    git(['reset', '--hard', '--quiet', 'HEAD'], dir);
    git(['clean', '-fd', '--quiet'], dir);
    return { dir, head: git(['rev-parse', '--short', 'HEAD'], dir).stdout.trim(), status: status(dir) };
}

function resetEso(dir, output) {
    const out = path.join(dir, output);
    fs.rmSync(out, { force: true });

    const hooksPath = path.join(dir, '.agents/hooks.json');
    if (!fs.existsSync(hooksPath)) throw new Error(`${dir}: missing .agents/hooks.json — the ESO wiring is gone`);
    let hooks;
    try {
        hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    } catch (err) {
        throw new Error(`${dir}: .agents/hooks.json is not valid JSON: ${err.message}`);
    }
    const blocks = Object.keys(hooks);
    if (!blocks.some((k) => k.startsWith('harness-eso'))) {
        throw new Error(`${dir}: no harness-eso blocks in .agents/hooks.json — re-provision before running`);
    }
    if (!fs.existsSync(path.join(dir, '.harness/host-pack/harness-hook.mjs'))) {
        throw new Error(`${dir}: missing .harness/host-pack/harness-hook.mjs — re-provision before running`);
    }
    return {
        dir,
        head: git(['rev-parse', '--short', 'HEAD'], dir).stdout.trim(),
        hooks: blocks.length,
        outputRemoved: fs.existsSync(out) === false,
        status: status(dir),
    };
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help || !opts.a || !opts.b) {
        console.log('usage: node scripts/pilot-reset.mjs --a <native-dir> --b <eso-dir> [--output docs/PILOT-CHECK.md]');
        return;
    }
    requireDir(opts.a, 'A');
    requireDir(opts.b, 'B');
    const a = resetNative(opts.a);
    const b = resetEso(opts.b, opts.output);
    if (!opts.quiet) {
        console.log(`A reset  ${a.dir}  head=${a.head}  clean=${a.status ? 'NO' : 'yes'}`);
        if (a.status) console.log(a.status.split('\n').map((l) => `  ${l}`).join('\n'));
        console.log(`B reset  ${b.dir}  head=${b.head}  hooks=${b.hooks} blocks  output-removed=${b.outputRemoved}`);
        if (b.status) console.log(b.status.split('\n').map((l) => `  ${l}`).join('\n'));
        console.log('\nready: open each folder in a NEW chat and paste the task once.');
    }
}

try {
    main();
} catch (err) {
    console.error(`pilot-reset: ${err.message}`);
    process.exit(1);
}
