/**
 * The tool gate for the DSH plugin — the same rules the host pack applies, without a subprocess.
 *
 * DSH's `tools/pre-execute` hands us `exec.name` and `exec.arguments` (the tool input), and expects
 * `{ kind: 'deny', reason }`, `{ kind: 'ask', reason }`, or `next()`. That is the write/shell gate:
 * the two channels B5 says must both be covered, decided from the consumer's own policy.
 *
 * Deliberately narrow: this module only answers "may this tool call proceed, and if not, why". It
 * reads files; it never writes, never spawns, and never throws for a malformed tool input — a throw
 * inside the plugin would end the step, which is a worse failure than allowing an unparsed call.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    CONFIG_NAME,
    consentCovers,
    loadDecisionPolicy,
    pathMode,
    projectIdFrom,
    resolvePathPolicy,
    shellHasWriteIntent,
    shellWriteTargets,
    toRepoRelative,
} from '@mu/harness-foundation/pure';

/** Tool names that write a single path. Lowercase compare: DSH tool ids are lowercase. */
export const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'create_file']);
/** Tool names that carry a shell command. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'powershell']);

/**
 * Walk up from a starting directory until a consumer root is found.
 *
 * A consumer is a directory that has `harness.config.json` or `.harness/`; anything else is not an ESO
 * workspace, and the plugin has no opinion there (it must not block an arbitrary repo the user opens).
 */
export function findConsumerRoot(start) {
    let dir = String(start || '').trim();
    if (!dir) return null;
    if (!path.isAbsolute(dir)) dir = path.resolve(dir);
    try {
        if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
    } catch {
        return null;
    }
    for (let i = 0; i < 20; i += 1) {
        if (fs.existsSync(path.join(dir, CONFIG_NAME)) || fs.existsSync(path.join(dir, '.harness'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

function argPath(args) {
    for (const key of ['path', 'file_path', 'filePath', 'target']) {
        const value = args?.[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

function argCommand(args) {
    for (const key of ['command', 'cmd', 'script']) {
        const value = args?.[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

/**
 * Resolve the root this call belongs to. Order: configured root, the directory of a written path,
 * then the process cwd. The tool path wins over cwd because DSH sessions can change directory.
 */
export function resolveRoot({ configRoot = null, args = null } = {}) {
    const candidates = [];
    if (configRoot) candidates.push(configRoot);
    const target = argPath(args);
    if (target && path.isAbsolute(target)) candidates.push(path.dirname(target));
    candidates.push(process.cwd());
    for (const candidate of candidates) {
        const root = findConsumerRoot(candidate);
        if (root) return root;
    }
    return null;
}

/**
 * @param {{ root: string, name: string, args: object }} input
 * @returns {{ kind: 'deny'|'ask', reason: string, path?: string } | null} null means "no opinion"
 */
export function decideToolCall({ root, name, args }) {
    if (!root) return null;
    const tool = String(name || '').toLowerCase();

    // `loadDecisionPolicyForCwd()` takes no root — it resolves from the process cwd, which is the
    // app directory inside DSH. The explicit root is the whole point of this gate.
    const loaded = loadDecisionPolicy({ root });
    const policy = loaded?.policy ?? {};
    const resolved = resolvePathPolicy(policy);
    const projectId = projectIdFrom(root);

    const targets = [];
    if (WRITE_TOOLS.has(tool)) {
        const target = argPath(args);
        if (target) targets.push(path.isAbsolute(target) ? target : path.join(root, target));
    } else if (SHELL_TOOLS.has(tool)) {
        const command = argCommand(args);
        if (!command) return null;
        for (const target of shellWriteTargets(command)) {
            if (target === '<unknown>' || !target) continue;
            targets.push(path.isAbsolute(target) ? target : path.join(root, target));
        }
        /* A write-intent command whose target cannot be resolved is still a write attempt. Denying
         * on the unparsed case is the safe direction for a channel with no evidence (B5). */
        if (!targets.length) {
            if (!shellHasWriteIntent(command)) return null;
            return {
                kind: 'deny',
                reason: 'harness-eso: shell command has write intent but its target could not be resolved; split it into a plain path or run it manually',
            };
        }
    } else {
        return null;
    }

    for (const target of targets) {
        const mode = pathMode(target, resolved, root);
        if (!mode) continue;
        const rel = toRepoRelative(target, root);
        if (mode === 'locked') {
            return { kind: 'deny', reason: `harness-eso: ${rel} is locked by the consumer's path policy (locked tier)`, path: rel };
        }
        if (mode === 'ask') {
            return { kind: 'ask', reason: `harness-eso: ${rel} needs approval (ask tier)`, path: rel };
        }
        if (mode === 'gated') {
            const consent = consentCovers(projectId, rel);
            if (consent.ok) continue;
            return {
                kind: 'ask',
                reason: `harness-eso: ${rel} is gated and has no live approval for project "${projectId || 'unknown'}"`,
                path: rel,
            };
        }
    }
    return null;
}
