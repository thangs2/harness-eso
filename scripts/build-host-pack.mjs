#!/usr/bin/env node
/**
 * Build the standalone host pack.
 *
 * The pack is what makes a consumer independent of this checkout: every hook implementation is
 * bundled into one file with no dependency outside `node:*`, so the consumer never needs
 * `@mu/*` on disk, never needs `node_modules`, and never needs the product repo to exist. The
 * IDE config only names a hook and a tree.
 *
 * Output layout (`packages/harness-host-generic/dist/host-pack/`):
 *
 *   harness-hook.mjs   bundled dispatcher — all hooks, zero external imports
 *   route-hook.py      route-trace helper, stdlib only, resolved pack-relative
 *   host-pack.json     version + per-file sha256, so a partial/corrupt install is detectable
 *
 * `host-pack.json` deliberately carries no checksum of itself: it is the thing being verified.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_GENERIC = path.join(ROOT, 'packages/harness-host-generic');
const ENTRY = path.join(HOST_GENERIC, 'src/dispatcher.mjs');
const ROUTE_PY = path.join(ROOT, 'packages/harness-observe-server/src/route-hook.py');
const OUT_DIR = path.join(HOST_GENERIC, 'dist/host-pack');

/** Files that make up the pack, in install order. */
export const PACK_FILES = ['harness-hook.mjs', 'route-hook.py', 'path-policy.default.json'];

/**
 * The product's default path policy, emitted as JSON for the **Python** guards.
 *
 * Those guards cannot import `@mu/harness-foundation`, so without this they would need their own copy
 * of the list — and two hand-maintained copies of a path list is exactly how the observer's copy came to
 * be blind to 9 of 19 protected paths. Generated from the single definition in `path-policy.mjs` at build
 * time, so there is still one thing to edit.
 */
async function writeDefaultPathPolicy() {
    const mod = await import(path.join(ROOT, 'packages/harness-foundation/src/path-policy.mjs'));
    fs.writeFileSync(
        path.join(OUT_DIR, 'path-policy.default.json'),
        `${JSON.stringify(mod.DEFAULT_PATH_POLICY, null, 2)}\n`,
    );
}

/** Import specifiers the bundle is still allowed to reference once built. */
const ALLOWED_EXTERNAL = /^node:/;

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Assert the bundle has no import outside Node builtins.
 *
 * This is the load-bearing invariant of the whole approach. A bundle that still imports `@mu/…`
 * or a bare specifier throws at hook time on the consumer, where nothing can resolve it — and a
 * guard that throws is a guard that either fails open or blocks every tool call. Catching it here
 * turns a runtime outage into a build failure.
 *
 * @param {string} source
 */
export function externalImports(source) {
    const found = new Set();
    const re = /(?:^|[\s;])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(source))) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        if (ALLOWED_EXTERNAL.test(spec)) continue;
        found.add(spec);
    }
    // Dynamic `import('…')` and `require('…')` are equally unresolvable on the consumer.
    const dyn = /(?:import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
    while ((m = dyn.exec(source))) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        if (ALLOWED_EXTERNAL.test(spec)) continue;
        found.add(spec);
    }
    return [...found];
}

async function bundle() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outfile = path.join(OUT_DIR, 'harness-hook.mjs');
    // Invoke the bundler as a child process so the script runs identically under `node` and
    // `bun` — CI uses `bun run`, but a container may only have plain node on PATH.
    const proc = spawnSync(
        'bun',
        ['build', ENTRY, '--target', 'node', '--outfile', outfile, '--format', 'esm'],
        { encoding: 'utf8', cwd: ROOT },
    );
    if (proc.error) throw new Error(`bun build failed to start: ${proc.error.message}`);
    if (proc.status !== 0) {
        throw new Error(`bun build failed (${proc.status}):\n${proc.stderr || proc.stdout}`);
    }
    return outfile;
}

function writeManifest() {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOST_GENERIC, 'package.json'), 'utf8'));
    const files = {};
    for (const name of PACK_FILES) {
        const p = path.join(OUT_DIR, name);
        if (!fs.existsSync(p)) throw new Error(`pack file missing after build: ${name}`);
        files[name] = sha256(fs.readFileSync(p));
    }
    const manifest = {
        version: pkg.version,
        entry: 'harness-hook.mjs',
        routeHelper: 'route-hook.py',
        files,
        /*
         * `SOURCE_DATE_EPOCH` (the reproducible-builds convention, set by release tooling) makes the
         * manifest stable, so two builds of unchanged sources produce identical bytes. Without it every
         * developer's build carries a different `builtAt` and the committed pack shows a modification
         * that is not one.
         */
        builtAt: new Date(
            (Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.now() / 1000)) * 1000,
        ).toISOString(),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'host-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

export async function buildHostPack() {
    const outfile = await bundle();
    const source = fs.readFileSync(outfile, 'utf8');

    const external = externalImports(source);
    if (external.length) {
        throw new Error(
            `host pack bundle has non-builtin imports (${external.join(', ')}) — it would fail on a consumer`,
        );
    }

    fs.copyFileSync(ROUTE_PY, path.join(OUT_DIR, 'route-hook.py'));
    try {
        fs.chmodSync(path.join(OUT_DIR, 'route-hook.py'), 0o755);
    } catch {
        /* best-effort */
    }

    await writeDefaultPathPolicy();

    const manifest = writeManifest();
    const bytes = PACK_FILES.reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
    return { outfile, manifest, bytes };
}

if (import.meta.main) {
    const { outfile, manifest, bytes } = await buildHostPack();
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(`host pack → ${OUT_DIR}`);
    console.log(`  ${manifest.entry}  ${kb(fs.statSync(path.join(OUT_DIR, manifest.entry)).size)}`);
    console.log(`  route-hook.py  ${kb(fs.statSync(path.join(OUT_DIR, 'route-hook.py')).size)}`);
    console.log(`  host-pack.json  version ${manifest.version}`);
    console.log(`  total ${kb(bytes)} · 0 external imports`);
    void outfile;
}
