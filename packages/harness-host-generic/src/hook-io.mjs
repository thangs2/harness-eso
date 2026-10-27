import fs from 'node:fs';
import path from 'node:path';
import { loadDecisionPolicy, sessionDir as foundationSessionDir } from '@mu/harness-foundation/pure';

const SHELL_TOOL_RE = /shell|terminal|bash|run_command|run_terminal|execute/i;

export function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        if (process.stdin.isTTY) resolve('');
    });
}

export function harnessTree() {
    const raw = (process.env.HARNESS_TREE || 'cursor').replace(/^\./, '').toLowerCase();
    if (raw === 'agents') return 'agents';
    if (raw === 'claude') return 'claude';
    return 'cursor';
}

/**
 * Session dir for this tree — one answer, shared with `guard-write.py`.
 *
 * Delegates to `@mu/harness-foundation`'s `sessionDir` rather than repeating the derivation. This file
 * used to have its own copy, which is how a second answer gets born: the guard would honour
 * `HARNESS_SESSION_DIR` while the pack kept writing `.cursor/session`, so on DSH the stamp landed
 * where nothing reads it and the write was denied anyway.
 */
export function sessionDir(root = process.cwd(), tree = harnessTree()) {
    return foundationSessionDir(root, tree);
}

export function detectShape(data) {
    if (harnessTree() === 'agents') return 'antigravity';
    if (harnessTree() === 'claude') return 'claude';
    if (!data || typeof data !== 'object') return 'cursor';
    if (data.transcript_path || data.permission_mode) return 'claude';
    const ev = String(data.hook_event_name || data.hookEventName || '');
    if (ev === 'UserPromptSubmit' || ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PreCompact') {
        if (data.session_id && data.cwd) return 'claude';
    }
    if (data.hook_event_name || data.hookEventName) return 'cursor';
    if (typeof data.toolCall === 'object') return 'antigravity';
    if (data.conversationId != null && data.stepIdx != null) return 'antigravity';
    return 'cursor';
}

export function currentEvent(explicitEvent) {
    if (explicitEvent) return explicitEvent;
    if (process.env.HARNESS_EVENT) return process.env.HARNESS_EVENT;
    const hook = process.env.HARNESS_HOOK;
    if (hook === 'gap-tracker' || hook === 'post-tool-hint') return 'PostToolUse';
    if (hook === 'guard-brain' || hook === 'guard-shell') return 'PreToolUse';
    if (hook === 'preflight') return harnessTree() === 'claude' ? 'UserPromptSubmit' : 'PreInvocation';
    if (hook === 'pre-compact') return harnessTree() === 'claude' ? 'PreCompact' : 'PreInvocation';
    return '';
}

export function emitHook(payload, shape, explicitEvent) {
    const out = { ...payload };
    const isAntigravity = shape === 'antigravity' || harnessTree() === 'agents';
    const isClaude = shape === 'claude' || harnessTree() === 'claude';

    if (isClaude) {
        const ev = currentEvent(explicitEvent);
        if (ev === 'UserPromptSubmit') {
            if (out.permission === 'deny') {
                process.stdout.write(
                    `${JSON.stringify({
                        decision: 'block',
                        reason: out.user_message || out.agent_message || 'denied',
                    })}\n`,
                );
                return;
            }
            if (out.additional_context) {
                process.stdout.write(
                    `${JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'UserPromptSubmit',
                            additionalContext: out.additional_context,
                        },
                    })}\n`,
                );
                return;
            }
            process.stdout.write('{}\n');
            return;
        }

        if (ev === 'PreToolUse') {
            if (out.permission === 'deny') {
                process.stdout.write(
                    `${JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: out.user_message || out.agent_message || 'denied',
                        },
                    })}\n`,
                );
                return;
            }
            if (out.additional_context) {
                process.stdout.write(
                    `${JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'allow',
                            additionalContext: out.additional_context,
                        },
                    })}\n`,
                );
                return;
            }
            process.stdout.write(
                `${JSON.stringify({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                    },
                })}\n`,
            );
            return;
        }

        if (ev === 'PostToolUse') {
            if (out.additional_context) {
                process.stdout.write(
                    `${JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            additionalContext: out.additional_context,
                        },
                    })}\n`,
                );
                return;
            }
            process.stdout.write('{}\n');
            return;
        }

        process.stdout.write('{}\n');
        return;
    }

    if (isAntigravity) {
        const ev = currentEvent(explicitEvent);

        // PostToolUse / Stop in Antigravity: Protobuf schema strictly forbids "decision".
        // Must return {} and exit 0.
        if (ev === 'PostToolUse' || ev === 'Stop') {
            process.stdout.write('{}\n');
            return;
        }

        // PreInvocation or PostInvocation in Antigravity:
        if (ev === 'PreInvocation' || ev === 'PostInvocation') {
            const steps = Array.isArray(out.injectSteps) ? out.injectSteps : [];
            process.stdout.write(`${JSON.stringify({ injectSteps: steps })}\n`);
            return;
        }

        // PreToolUse (or default for Antigravity):
        if (out.permission === 'deny') {
            process.stdout.write(
                `${JSON.stringify({
                    decision: 'deny',
                    reason: out.user_message || out.agent_message || 'denied',
                })}\n`,
            );
            return;
        }
        if (out.additional_context) {
            process.stdout.write(
                `${JSON.stringify({ decision: 'allow', additionalContext: out.additional_context })}\n`,
            );
            return;
        }
        process.stdout.write('{"decision":"allow"}\n');
        return;
    }

    process.stdout.write(`${JSON.stringify(out)}\n`);
}

export function allow(shape, extra = {}, explicitEvent = undefined) {
    emitHook({ permission: 'allow', ...extra }, shape, explicitEvent);
}

export function deny(shape, message, extra = {}, explicitEvent = undefined) {
    emitHook(
        {
            permission: 'deny',
            user_message: message,
            agent_message: message,
            ...extra,
        },
        shape,
        explicitEvent,
    );
}

export function extractShellCommand(data) {
    if (!data || typeof data !== 'object') return '';
    const direct = data.command || data.CommandLine || data.tool_input?.command || data.tool_input?.CommandLine;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const call = typeof data.toolCall === 'object' ? data.toolCall : {};
    const name = String(call.name || data.tool_name || '');
    const args = typeof call.args === 'object' ? call.args : (typeof data.tool_input === 'object' ? data.tool_input : {});
    for (const key of ['CommandLine', 'commandLine', 'command', 'Command', 'cmd', 'script', 'input', 'text']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    if (name && (SHELL_TOOL_RE.test(name) || name.toLowerCase() === 'bash')) {
        return String(args.CommandLine || args.commandLine || args.command || args.Command || '').trim();
    }
    return '';
}

export function extractToolMeta(data) {
    if (!data || typeof data !== 'object') {
        return { toolName: '', toolInput: {}, path: '' };
    }
    const toolName =
        data.tool_name ||
        data.tool ||
        data.toolCall?.name ||
        data.tool_call?.name ||
        '';
    const toolInput =
        data.tool_input ||
        data.toolInput ||
        data.toolCall?.args ||
        data.tool_call?.arguments ||
        {};
    const filePath =
        data.file_path ||
        data.path ||
        toolInput.path ||
        toolInput.file_path ||
        toolInput.AbsolutePath ||
        toolInput.SearchPath ||
        toolInput.DirectoryPath ||
        toolInput.TargetFile ||
        toolInput.projectPath ||
        '';
    return { toolName: String(toolName), toolInput, path: String(filePath || '') };
}

export function loadPolicyForCwd() {
    return loadDecisionPolicy({ root: process.cwd() });
}

export function readJsonFile(fp) {
    try {
        if (!fp || !fs.existsSync(fp)) return null;
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
        return null;
    }
}

export function writeJsonFile(fp, doc) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export const AGY_CACHE_FILE = '.agy-tool-cache.json';
const AGY_CACHE_MAX_ENTRIES = 32;
const AGY_CACHE_MAX_AGE_MS = 60_000;

export function agyCachePath(root = process.cwd(), tree = harnessTree()) {
    return path.join(sessionDir(root, tree), AGY_CACHE_FILE);
}

export function saveAgyToolCache(data, opts = {}) {
    const root = opts.root || process.cwd();
    const tree = opts.tree || harnessTree();
    if (tree !== 'agents') return;

    const { toolName, toolInput } = extractToolMeta(data);
    if (!toolName) return;

    const callId =
        data.toolCall?.id ||
        data.tool_call_id ||
        data.toolCallId ||
        (data.conversationId && data.stepIdx != null ? `${data.conversationId}:${data.stepIdx}` : null);

    const fp = agyCachePath(root, tree);
    let doc = readJsonFile(fp);
    let queue = [];
    if (Array.isArray(doc)) {
        queue = doc;
    } else if (doc && typeof doc === 'object' && Array.isArray(doc.__queue__)) {
        queue = doc.__queue__;
    } else {
        doc = doc && typeof doc === 'object' ? doc : {};
    }

    const now = Date.now();
    queue = queue.filter((e) => typeof e.ts === 'number' && now - e.ts < AGY_CACHE_MAX_AGE_MS);

    const idx = callId ? queue.findIndex((e) => e.callId === callId) : -1;
    const entry = {
        callId: callId || undefined,
        toolName,
        toolInput: toolInput || {},
        ts: now,
    };

    if (idx >= 0) {
        queue[idx] = entry;
    } else {
        queue.push(entry);
    }

    if (queue.length > AGY_CACHE_MAX_ENTRIES) {
        queue.splice(0, queue.length - AGY_CACHE_MAX_ENTRIES);
    }

    if (Array.isArray(doc)) {
        writeJsonFile(fp, queue);
    } else {
        doc.__queue__ = queue;
        writeJsonFile(fp, doc);
    }
}

export function popAgyToolCache(data, opts = {}) {
    const root = opts.root || process.cwd();
    const tree = opts.tree || harnessTree();
    const fp = agyCachePath(root, tree);
    let doc = readJsonFile(fp);
    if (!doc) return null;

    let queue = [];
    if (Array.isArray(doc)) {
        queue = doc;
    } else if (typeof doc === 'object' && Array.isArray(doc.__queue__)) {
        queue = doc.__queue__;
    } else {
        return null;
    }

    if (!queue.length) return null;

    const now = Date.now();
    const freshQueue = queue.filter((e) => typeof e.ts === 'number' && now - e.ts < AGY_CACHE_MAX_AGE_MS);

    const callId =
        data?.toolCall?.id ||
        data?.tool_call_id ||
        data?.toolCallId ||
        (data?.conversationId && data?.stepIdx != null ? `${data.conversationId}:${data.stepIdx}` : null);

    const requestedName = data?.tool_name || data?.toolName || data?.toolCall?.name || '';

    let matchIdx = -1;
    if (callId) {
        matchIdx = freshQueue.findIndex((e) => e.callId === callId);
    }
    /*
     * Falling back to the first entry of the same tool name is how a replay hands the wrong path to
     * the gap tracker: `view_file /path/to/AGENTS.md` and `view_file AGENTS.md` share a name, and the
     * caller only knows the name. That fallback used to be harmless because a law gap matched on a
     * *substring of any path* (H1), so either entry closed it. It is no longer harmless: the two paths
     * now decide differently, and guessing made a deliberate negative assertion fail while looking
     * like a bug in the matching. When there is no `callId`, only a **unique** name is unambiguous;
     * with more than one candidate the answer is "unknown" and the caller keeps its own input.
     */
    if (matchIdx === -1 && requestedName && requestedName !== '*') {
        const sameName = [];
        for (let i = 0; i < freshQueue.length; i += 1) {
            if (freshQueue[i].toolName.toLowerCase() === requestedName.toLowerCase()) sameName.push(i);
        }
        if (sameName.length === 1) matchIdx = sameName[0];
    }
    if (matchIdx === -1 && (!requestedName || requestedName === '*')) {
        matchIdx = 0; // FIFO pop
    }

    if (matchIdx === -1) {
        return null;
    }

    const [matched] = freshQueue.splice(matchIdx, 1);
    if (Array.isArray(doc)) {
        writeJsonFile(fp, freshQueue);
    } else {
        doc.__queue__ = freshQueue;
        writeJsonFile(fp, doc);
    }
    return matched;
}

