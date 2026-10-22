/**
 * Route hook — pipes the host payload to observe-server `route-hook.py` and forwards its
 * decision. Antigravity passes `--event PreToolUse|PostToolUse|PreInvocation|…`.
 *
 * `route-hook.py` ships inside the host pack next to this module, so resolution is
 * pack-relative — no checkout path and no `HARNESS_ESO_ROOT` involved.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveRouteHookPy() {
    const candidates = [path.join(PKG_DIR, 'route-hook.py'), path.join(PKG_DIR, '..', 'route-hook.py')];
    for (const fp of candidates) {
        if (fs.existsSync(fp)) return fp;
    }
    return null;
}

/**
 * Find a Python 3 interpreter, in the order a machine is likely to have one.
 *
 * `spawnSync('python3', …)` was the whole of P3 (issue #12): Windows ships `python.exe` and `py.exe`,
 * never `python3`, so the spawn failed with ENOENT and the route trace disappeared **silently** — the
 * caller fails open by design, so there was no error, no counter, and nothing in a test on macOS.
 *
 * The list is ordered so the same machine always picks the same interpreter: an explicit override,
 * then the POSIX name, then the two Windows launchers. Probing is one `spawnSync` per candidate and
 * only happens on the route hook (once per prompt/tool event), not on a per-file hot path.
 *
 * @returns {string|null} an executable name that exists, or null
 */
export function resolvePython() {
    const explicit = process.env.HARNESS_PYTHON;
    if (explicit) return explicit;
    const candidates = ['python3', process.platform === 'win32' ? 'python' : 'python3', 'python', 'py'];
    const seen = new Set();
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'], {
            encoding: 'utf8',
            timeout: 10_000,
        });
        // `error.code === 'ENOENT'` is the Windows/POSIX "no such binary"; any other non-zero exit is a
        // Python 2 or a broken install, neither of which can run route-hook.py.
        if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
}

function harnessId() {    const tree = String(process.env.HARNESS_TREE || process.env.ROUTE_HARNESS || 'cursor')
        .replace(/^\./, '')
        .toLowerCase();
    if (tree === 'agents') return 'agents';
    if (tree === 'claude') return 'claude';
    return 'cursor';
}

function parseEventArg(argv) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--event' && argv[i + 1]) return argv[i + 1];
        if (argv[i].startsWith('--event=')) return argv[i].split('=')[1];
    }
    return process.env.HARNESS_EVENT || process.env.ROUTE_AGY_EVENT || '';
}

function failOpenStdout(event) {
    const hid = harnessId();
    const ev = event || '';
    if (hid === 'claude') {
        if (ev === 'PreToolUse') return '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n';
        return '{}\n';
    }
    if (hid === 'agents') {
        if (ev === 'PreToolUse') return '{"decision":"allow"}\n';
        if (ev === 'PreInvocation' || ev === 'PostInvocation') return '{"injectSteps":[]}\n';
        return '{}\n';
    }
    if (ev === 'PreToolUse') return '{"decision":"allow"}\n';
    if (ev === 'PreInvocation' || ev === 'PostInvocation') return '{"injectSteps":[]}\n';
    return '{"permission":"allow"}\n';
}

export function run(argv = process.argv.slice(2)) {
    const event = parseEventArg(argv);
    const script = resolveRouteHookPy();
    const input = fs.readFileSync(0, 'utf8');

    if (!script) {
        process.stdout.write(failOpenStdout(event));
        return;
    }

    const pyArgs = [script, '--harness', harnessId()];
    if (event) pyArgs.push('--event', event);

    const python = resolvePython();
    if (!python) {
        // Not silent any more: the trace is gone either way, but "no python3 on this host" is a
        // diagnosis, and the failure used to be indistinguishable from "nothing to trace".
        process.stderr.write('harness route-hook: no Python 3 interpreter found (set HARNESS_PYTHON to override)\n');
        process.stdout.write(failOpenStdout(event));
        return;
    }

    const proc = spawnSync(python, pyArgs, {
        input,
        cwd: process.cwd(),
        encoding: 'utf8',
    });

    const out = (proc.stdout || '').trim();
    if (out) {
        process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
        return;
    }
    process.stdout.write(failOpenStdout(event));
}
