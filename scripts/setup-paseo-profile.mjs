#!/usr/bin/env node
/**
 * Wire the DSH profile that Paseo spawns (`dsh --profile paseo`) to the local AgentMemory MCP plugin.
 *
 * Why a script and not a manual edit: the profile is outside every repo, so the change is invisible to
 * `git status`, and it has three parts that must agree — the bundle list, the `link:` dependency, and
 * the pnpm install that materialises it. Forgetting the dependency is silent: the loader cannot resolve
 * the package and the agent simply has no memory tools, with no error in the transcript.
 *
 * What it does, in order:
 *   1. patch `$DSH_HOME/profiles/<profile>/package.json` (idempotent, timestamped backup before write)
 *   2. `dsh plugin --profile <profile> install` — pnpm, in the profile directory
 *   3. warm the npm cache with `@agentmemory/mcp`, because the shim runs `npx -y --offline`
 *      and an offline resolve against a cold cache fails the handshake (0 tools, no log line)
 *   4. run the plugin's own selfcheck against this repo
 *
 *   node scripts/setup-paseo-profile.mjs            # apply
 *   node scripts/setup-paseo-profile.mjs --check    # read-only, exit 1 when not wired
 *   node scripts/setup-paseo-profile.mjs --no-warm  # skip step 3 (no network)
 *
 * Exit codes: 0 done · 1 operation failed · 2 usage / profile not found.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = '@local/agentmemory-mcp-plugin';
const BRIDGE = 'dsh-paseo-bridge';
const PLUGIN_SRC = path.join(REPO_ROOT, 'tools', 'dsh-plugins', 'agentmemory');

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PKG_PATH = path.join(PROFILE_DIR, 'package.json');
const DSH_BIN = process.env.DSH_BINARY ?? 'dsh';

const argv = new Set(process.argv.slice(2));
const checkOnly = argv.has('--check');
const warm = !argv.has('--no-warm');
const unknown = [...argv].filter((a) => !['--check', '--no-warm', '--help', '-h'].includes(a));

function fail(code, message) {
    console.error(`✖ ${message}`);
    process.exit(code);
}

function readProfile() {
    if (!fs.existsSync(PKG_PATH)) {
        fail(2, `no DSH profile at ${PKG_PATH} — is Paseo installed and has it booted once?`);
    }
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

/** Patch in memory, returning the next profile and whether anything changed. */
function plan(profile) {
    const next = JSON.parse(JSON.stringify(profile));
    next.dsh ??= { profile: { bundles: [] } };
    next.dsh.profile.bundles ??= [];

    const bundles = next.dsh.profile.bundles.filter((name) => name !== PLUGIN);
    const bridgeAt = bundles.indexOf(BRIDGE);
    bundles.splice(bridgeAt === -1 ? bundles.length : bridgeAt, 0, PLUGIN);
    next.dsh.profile.bundles = bundles;

    next.dependencies = { ...(next.dependencies ?? {}), [PLUGIN]: `link:${PLUGIN_SRC}` };
    return { next, changed: JSON.stringify(next) !== JSON.stringify(profile) };
}

function writeProfile(next) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${PKG_PATH}.bak-${stamp}`;
    fs.copyFileSync(PKG_PATH, backup);
    fs.writeFileSync(PKG_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`✔ patched ${PKG_PATH}`);
    console.log(`  backup: ${path.basename(backup)}`);
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') {
        fail(2, `\`${command}\` not found on PATH — pass DSH_BINARY=/abs/path/to/dsh`);
    }
    return result.status ?? 1;
}

/** The plugin resolves node_modules symlinks per profile; a missing link means pnpm never ran. */
function installed() {
    return fs.existsSync(path.join(PROFILE_DIR, 'node_modules', PLUGIN, 'package.json'))
        || fs.existsSync(path.join(PROFILE_DIR, 'node_modules', '@local', 'agentmemory-mcp-plugin', 'package.json'));
}

function main() {
    if (argv.has('--help') || argv.has('-h')) {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, ''));
        return 0;
    }
    if (unknown.length > 0) fail(2, `unknown argument(s): ${unknown.join(' ')}`);

    const profile = readProfile();
    const { next, changed } = plan(profile);
    const wired = !changed && installed();

    if (checkOnly) {
        console.log(`profile:   ${PROFILE_DIR}`);
        console.log(`bundle:    ${profile.dsh?.profile?.bundles?.includes(PLUGIN) ? 'yes' : 'no'}`);
        console.log(`link dep:  ${profile.dependencies?.[PLUGIN] ?? 'missing'}`);
        console.log(`installed: ${installed() ? 'yes' : 'no'}`);
        console.log(wired ? '✔ wired' : '✖ not wired — run without --check');
        return wired ? 0 : 1;
    }

    if (changed) writeProfile(next);
    else console.log(`✔ profile already declares ${PLUGIN}`);

    if (run(DSH_BIN, ['plugin', '--profile', PROFILE, 'install'], PROFILE_DIR) !== 0) {
        fail(1, 'pnpm install failed in the profile directory');
    }
    if (!installed()) fail(1, `${PLUGIN} still missing from ${PROFILE_DIR}/node_modules`);

    // pnpm prunes packages the manifest does not declare, and the bridge is written into node_modules
    // by the Paseo plugin's own bootstrap rather than declared here. It is rewritten on every plugin
    // load, so this is recoverable — but only after the reload, and until then no agent can start.
    if (!fs.existsSync(path.join(PROFILE_DIR, 'node_modules', BRIDGE))) {
        console.warn(`⚠ pnpm removed ${BRIDGE} from node_modules — the Paseo plugin rewrites it on load.`);
        console.warn('  Reload the dsh-paseo plugin BEFORE starting any new agent.');
    }

    if (warm) {
        // `npx -y --offline` in the plugin row needs the packument AND the full dependency tree cached;
        // `npm cache add` only warms the requested package, so install into a throwaway prefix instead.
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-warm-'));
        console.log('… warming npm cache for @agentmemory/mcp (network, one time)');
        const status = run('npm', ['i', '--prefix', scratch, '--no-audit', '--no-fund', '@agentmemory/mcp'], REPO_ROOT);
        fs.rmSync(scratch, { recursive: true, force: true });
        if (status !== 0) console.warn('⚠ cache warm failed — the shim may still fall back to the network');
    }

    const selfcheck = path.join(PLUGIN_SRC, 'src', 'selfcheck.mjs');
    if (fs.existsSync(selfcheck)) {
        console.log('… selfcheck (workspace = this repo)');
        run(process.execPath, [selfcheck, REPO_ROOT], REPO_ROOT);
    }

    console.log(`\nNext: reload the \`dsh-paseo\` plugin in Paseo (Settings → Plugins) — a reload ends running turns.`);
    console.log(`Then a new agent should list memory_smart_search / memory_save. Check with: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} --check`);
    return 0;
}

process.exit(main());
