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

function harnessId() {
    const tree = String(process.env.HARNESS_TREE || process.env.ROUTE_HARNESS || 'cursor')
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

    const proc = spawnSync('python3', pyArgs, {
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
