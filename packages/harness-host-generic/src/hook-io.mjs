import fs from 'node:fs';
import path from 'node:path';
import { loadDecisionPolicy } from '@mu/harness-foundation/pure';

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
    return (process.env.HARNESS_TREE || 'cursor').replace(/^\./, '').toLowerCase() === 'agents'
        ? 'agents'
        : 'cursor';
}

export function sessionDir(root = process.cwd(), tree = harnessTree()) {
    return tree === 'agents'
        ? path.join(root, '.agents', 'session')
        : path.join(root, '.cursor', 'session');
}

export function detectShape(data) {
    if (!data || typeof data !== 'object') return harnessTree() === 'agents' ? 'antigravity' : 'cursor';
    if (data.hook_event_name || data.hookEventName) return 'cursor';
    if (typeof data.toolCall === 'object') return 'antigravity';
    if (data.conversationId != null && data.stepIdx != null) return 'antigravity';
    return harnessTree() === 'agents' ? 'antigravity' : 'cursor';
}

export function currentEvent(explicitEvent) {
    if (explicitEvent) return explicitEvent;
    if (process.env.HARNESS_EVENT) return process.env.HARNESS_EVENT;
    const hook = process.env.HARNESS_HOOK;
    if (hook === 'gap-tracker' || hook === 'post-tool-hint') return 'PostToolUse';
    if (hook === 'guard-brain' || hook === 'guard-shell') return 'PreToolUse';
    if (hook === 'preflight' || hook === 'pre-compact') return 'PreInvocation';
    return '';
}

export function emitHook(payload, shape, explicitEvent) {
    const out = { ...payload };
    const isAntigravity = shape === 'antigravity' || harnessTree() === 'agents';

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
    const direct = data.command || data.CommandLine;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const call = typeof data.toolCall === 'object' ? data.toolCall : {};
    const name = String(call.name || '');
    const args = typeof call.args === 'object' ? call.args : {};
    for (const key of ['CommandLine', 'commandLine', 'command', 'Command', 'cmd', 'script', 'input', 'text']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    if (name && SHELL_TOOL_RE.test(name)) {
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
