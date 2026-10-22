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
 * A consumer is a directory that declares itself with `harness.config.json` or
 * `.harness/decision-policy.json`; anything else is not an ESO workspace, and the plugin has no opinion
 * there (it must not block an arbitrary repo the user opens).
 */
export function findConsumerRoot(start) {
    let dir = String(start || '').trim();
    if (!dir) return null;
    if (!path.isAbsolute(dir)) dir = path.resolve(dir);
    try {
        if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
    } catch {
        /* A target that does not exist yet is the normal case for a write (`secrets/new.txt`): walk up
         * from where it would live instead of giving up on the call. */
    }
    for (let i = 0; i < 20; i += 1) {
        /*
         * A consumer **declares** itself: a config, or an explicit policy. `.harness/` alone is product
         * state (the CLI writes workspace/tenants/pid there), so treating it as a marker made the gate
         * police the product checkout itself — the one repo AGENTS.md says must not run ESO.
         */
        if (fs.existsSync(path.join(dir, CONFIG_NAME)) || fs.existsSync(path.join(dir, '.harness', 'decision-policy.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

/**
 * A shell redirect, or `tee` used as a command.
 *
 * Two false positives this rule already paid for: the word `tee` inside a commit message was read as a
 * command, and `=>` inside a `node -e` snippet was read as `>`. A redirect operator is `>`/`>>` that is
 * not part of `=>`, `->`, `<>` or `2>&1`.
 */
function hasShellRedirect(command) {
    const text = String(command || '');
    const redirect = /(?<![=<>-])>>?\s*[^\s&|]/.test(text);
    const tee = /\|\s*tee\b/.test(text) || /(?:^|[;&]\s*)tee\b/.test(text);
    return redirect || tee;
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

/**
 * A tier that is not "allowed yet" becomes a deny by default.
 *
 * Reason: inside DSH an `ask` decision is not a gate. Its approval path belongs to the host's permission
 * preset, and `deny` is the only answer that reliably stops the call — measured, on a gated path whose
 * write went through under `ask`. A consumer that trusts its host's approval UI can opt in with
 * `askMode: 'host'`; the default keeps the guard a guard.
 */
function approval(reason, rel, askMode) {
    if (askMode === 'host') return { kind: 'ask', reason, path: rel };
    return {
        kind: 'deny',
        reason: `${reason}; ask the operator to record consent, or set askMode=host to delegate to the host's approval UI`,
        path: rel,
    };
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
export function decideToolCall({ root = null, configRoot = null, sessionRoot = null, name, args, askMode = 'deny' }) {
    const tool = String(name || '').toLowerCase();

    let command = null;
    let raw = [];
    if (WRITE_TOOLS.has(tool)) {
        const target = argPath(args);
        if (target) raw.push(target);
    } else if (SHELL_TOOLS.has(tool)) {
        command = argCommand(args);
        if (!command) return null;
        raw = shellWriteTargets(command).filter(
            (target) => target && target !== '<unknown>' && !target.includes('$') && !target.startsWith('~'),
        );
    } else {
        return null;
    }

    /*
     * Root resolution has to consider **what the call writes**, not only the process cwd: inside DSH the
     * cwd is the app directory, so a shell command writing `/work/consumer/secrets/x` is otherwise
     * judged with no consumer at all and allowed. Absolute targets come first; a relative-only call
     * still needs a configured root or a cwd that is a consumer.
     */
    const candidates = [];
    if (root) candidates.push(root);
    if (configRoot) candidates.push(configRoot);
    /* The session's directory is the real cwd of the tool call — DSH's `workingDirectory` service. */
    if (sessionRoot) candidates.push(sessionRoot);
    for (const target of raw) {
        if (path.isAbsolute(target)) candidates.push(path.dirname(target));
    }
    candidates.push(process.cwd());

    let consumer = null;
    for (const candidate of candidates) {
        consumer = findConsumerRoot(candidate);
        if (consumer) break;
    }
    if (!consumer) return null;

    const loaded = loadDecisionPolicy({ root: consumer });
    const policy = loaded?.policy ?? {};
    const resolved = resolvePathPolicy(policy);
    const projectId = projectIdFrom(consumer);

    const targets = [];
    for (const target of raw) targets.push(path.isAbsolute(target) ? target : path.join(consumer, target));

    if (!targets.length && command) {
        /*
         * Before deciding what an unparsed write means, look at what it actually names: a Python
         * heredoc writes through a string literal, which the shared matcher only finds when that
         * literal is absolute.
         */
        /*
         * Stricter than the shared matcher on purpose: the host pack gets the event's `path` as a second
         * signal, this plugin does not. A redirect whose target is a variable (`> $OUT`) therefore counts
         * as write intent here, and with no resolvable target it is denied below rather than ignored.
         */
        if (!shellHasWriteIntent(command) && !hasShellRedirect(command)) return null;
        if (!hasShellRedirect(command)) {
            for (const rel of relativeLiterals(command)) targets.push(path.join(consumer, rel));
            if (!targets.length) return null; // a script that names no path is nothing this gate can judge
        } else {
            /* A redirect or `tee` whose target cannot be resolved is still a write attempt, and a
             * channel with no evidence is the one case where denying is the safe direction (B5). */
            return {
                kind: 'deny',
                reason:
                    'harness-eso: shell command has write intent but its target could not be resolved; ' +
                    'split it into a plain path or run it manually',
            };
        }
    }

    for (const target of targets) {
        const mode = pathMode(target, resolved, consumer);
        if (!mode) continue;
        const rel = toRepoRelative(target, consumer);
        if (mode === 'locked') {
            return {
                kind: 'deny',
                reason: `harness-eso: ${rel} is locked by the consumer's path policy (locked tier)`,
                path: rel,
                /* The consumer the gate decided against, so a caller can attribute the record. */
                root: consumer,
            };
        }
        if (mode === 'ask') {
            return { ...approval(`harness-eso: ${rel} needs approval (ask tier)`, rel, askMode), root: consumer };
        }
        if (mode === 'gated') {
            const consent = consentCovers(projectId, rel);
            if (consent.ok) continue;
            return {
                ...approval(
                    `harness-eso: ${rel} is gated and has no live approval for project "${projectId || 'unknown'}"`,
                    rel,
                    askMode,
                ),
                root: consumer,
            };
        }
    }
    return null;
}
