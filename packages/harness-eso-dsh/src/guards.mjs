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

/**
 * A shell redirect, or `tee` used as a command.
 *
 * `tee` must be a command, not the word: a commit message that says "a redirect or `tee`" is prose, and
 * treating prose as a redirect denied a harmless `git commit -F - <<'EOF'`.
 */
function hasShellRedirect(command) {
    const text = String(command || '');
    return /[^<]>>?\s*[^\s&]/.test(text) || /\|\s*tee\b/.test(text) || /(?:^|[;&]\s*)tee\b/.test(text);
}

/** Repo-relative path literals a script names, e.g. `open('AGENTS.md','w')`. */
const REL_LITERAL_RE =
    /['"]([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|mdx|mjs|cjs|js|ts|json|jsonl|ya?ml|sql|py|txt|toml|sh|ps1|css|html))['"]/g;

function relativeLiterals(command) {
    const out = [];
    for (const match of String(command || '').matchAll(REL_LITERAL_RE)) {
        const rel = match[1];
        if (rel.startsWith('/') || rel.split('/').includes('..')) continue;
        if (!out.includes(rel)) out.push(rel);
    }
    return out;
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
            // A shell variable is not a path: `> $TARGET` must fall through to the unresolved case,
            // not be joined to the root and quietly allowed.
            if (target.includes('$') || target.startsWith('~')) continue;
            targets.push(path.isAbsolute(target) ? target : path.join(root, target));
        }
        /*
         * Before deciding what an unparsed write means, look at what it actually names.
         *
         * A Python heredoc writes through a string literal, which the shared matcher only finds when
         * that literal is absolute. A repo-relative literal (`open('AGENTS.md','w')`) is a normal way
         * to write and must be checked against the policy, not denied for being unparsed.
         */
        if (!targets.length) {
            if (!shellHasWriteIntent(command)) return null;
            if (!hasShellRedirect(command)) {
                for (const rel of relativeLiterals(command)) targets.push(path.join(root, rel));
                // A script that names no path at all is nothing this gate can judge.
                if (!targets.length) return null;
            } else {
                /* A redirect or `tee` whose target cannot be resolved is still a write attempt, and a
                 * channel with no evidence is the one case where denying is the safe direction (B5). */
                return {
                    kind: 'deny',
                    reason: 'harness-eso: shell command has write intent but its target could not be resolved; split it into a plain path or run it manually',
                };
            }
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
