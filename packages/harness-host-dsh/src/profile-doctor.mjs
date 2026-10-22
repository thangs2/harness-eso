/**
 * DSH profile doctor — the check that would have stopped ATF-OPS-001 before it cost a session.
 *
 * `@deepseek-ai/dsh-tools` exports `TOOL_RUNTIME_SCHEDULER` as `Symbol()`. Two copies of that module
 * (one inside `app.asar`, one hoisted into the profile by a plugin's peerDependencies) produce two
 * different Symbols, so `dsh-agent-loop` looks up `ctx.tools[TOOL_RUNTIME_SCHEDULER]`, gets
 * `undefined`, and every tool call dies at `.prepare(...)`:
 *
 *   Cannot read properties of undefined (reading 'prepare')
 *
 * The invariant is therefore not "the plugin failed to load" but "a profile must not declare or hold
 * a second instance of a package the app already ships, when that package exports a cross-package
 * symbol". This module checks exactly that, from on-disk evidence only — it loads nothing.
 *
 * Read-only. The one thing it cannot see is which instance the *running* process loaded, so it must
 * be run after a restart, not as proof that the live process is healthy.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Packages whose cross-package contracts use `Symbol()` identity (ATF-OPS-001 §3.3). */
export const SYMBOL_BEARING_PACKAGES = Object.freeze([
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-shell',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-working-directory',
    '@deepseek-ai/dsh-hook-protocol',
]);

/** The packages a plugin commonly drags in as peers; named separately so the message can be specific. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code';

/** `~/.dsh`, overridable the way the app overrides it. */
export function dshHome(env = process.env) {
    return env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

function readJson(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function listProfiles(home) {
    const dir = path.join(home, 'profiles');
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .filter((entry) => fs.existsSync(path.join(dir, entry.name, 'package.json')))
        .map((entry) => entry.name)
        .sort();
}

function checkPatchIds(profileDir) {
    /* One mount id must appear in one layer: a row in the user patch and the same row in a bundle
     * patch mounts the plugin twice (double hooks, double state). */
    const layers = [{ name: 'user', file: path.join(profileDir, 'cordis.patch.yml') }];
    const modules = path.join(profileDir, 'node_modules');
    try {
        for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const pkgDir = path.join(modules, entry.name);
            if (entry.name.startsWith('@')) {
                let scoped = [];
                try {
                    scoped = fs.readdirSync(pkgDir, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const inner of scoped) {
                    const patch = path.join(pkgDir, inner.name, 'cordis.patch.yml');
                    if (fs.existsSync(patch)) layers.push({ name: `${entry.name}/${inner.name}`, file: patch });
                }
                continue;
            }
            const patch = path.join(pkgDir, 'cordis.patch.yml');
            if (fs.existsSync(patch)) layers.push({ name: entry.name, file: patch });
        }
    } catch {
        /* no node_modules is the healthy case */
    }

    const seen = new Map();
    const collisions = [];
    for (const layer of layers) {
        let text;
        try {
            text = fs.readFileSync(layer.file, 'utf8');
        } catch {
            continue;
        }
        for (const match of text.matchAll(/^\s*-?\s*id:\s*['"]?([A-Za-z0-9_.:-]+)['"]?\s*$/gm)) {
            const id = match[1];
            if (seen.has(id) && seen.get(id) !== layer.name) {
                collisions.push({ id, layers: [seen.get(id), layer.name] });
            } else {
                seen.set(id, layer.name);
            }
        }
    }
    return collisions;
}

/**
 * @param {{ home?: string, profile?: string }} [options]
 * @returns {{ verdict: 'healthy'|'pathology-present'|'unverified', home: string,
 *             profiles: Array<{profile: string, verdict: string, checks: object[]}> }}
 */
export function checkDshProfiles(options = {}) {
    const home = options.home || dshHome();
    const profiles = options.profile ? [options.profile] : listProfiles(home);
    const results = [];

    for (const profile of profiles) {
        const dir = path.join(home, 'profiles', profile);
        const checks = [];
        const manifest = readJson(path.join(dir, 'package.json'));

        if (!manifest.ok) {
            checks.push({ id: 'P0.manifest', status: 'warn', detail: `cannot read package.json: ${manifest.error}` });
            results.push({ profile, verdict: 'unverified', checks });
            continue;
        }

        const declared = Object.keys(manifest.value?.dependencies ?? {});
        const offenders = declared.filter((name) => SYMBOL_BEARING_PACKAGES.includes(name));
        checks.push(
            offenders.length
                ? {
                      id: 'P1.declared',
                      status: 'fail',
                      detail:
                          `declares app-shipped symbol-bearing package(s): ${offenders.join(', ')} — ` +
                          'a profile-local copy splits Symbol identity and breaks every tool call',
                  }
                : { id: 'P1.declared', status: 'pass', detail: `${declared.length} declared dependency(ies), none symbol-bearing` },
        );

        const modules = path.join(dir, 'node_modules');
        const present = [];
        if (fs.existsSync(modules)) {
            for (const name of SYMBOL_BEARING_PACKAGES) {
                if (fs.existsSync(path.join(modules, name, 'package.json'))) present.push(name);
            }
        }
        checks.push(
            present.length
                ? {
                      id: 'P2.node_modules',
                      status: 'fail',
                      detail: `a second instance is on disk: ${present.join(', ')} — move it aside before the app boots`,
                  }
                : { id: 'P2.node_modules', status: 'pass', detail: 'no profile-local copy of a symbol-bearing package' },
        );

        const collisions = checkPatchIds(dir);
        checks.push(
            collisions.length
                ? {
                      id: 'P3.patch-ids',
                      status: 'warn',
                      detail: `mount id declared twice: ${collisions.map((c) => `${c.id} (${c.layers.join(' + ')})`).join('; ')}`,
                  }
                : { id: 'P3.patch-ids', status: 'pass', detail: 'mount ids are unique across layers' },
        );

        const verdict = checks.some((c) => c.status === 'fail')
            ? 'pathology-present'
            : checks.some((c) => c.status === 'warn')
              ? 'unverified'
              : 'healthy';
        results.push({ profile, verdict, checks });
    }

    const verdict = results.some((r) => r.verdict === 'pathology-present')
        ? 'pathology-present'
        : results.some((r) => r.verdict === 'unverified')
          ? 'unverified'
          : 'healthy';
    return { verdict, home, profiles: results };
}
