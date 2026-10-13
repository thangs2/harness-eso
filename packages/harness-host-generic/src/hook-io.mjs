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
    if (!data || typeof data !== 'object') return 'cursor';
    if (data.hook_event_name || data.hookEventName) return 'cursor';
    if (typeof data.toolCall === 'object') return 'antigravity';
    if (data.conversationId != null && data.stepIdx != null) return 'antigravity';
    return 'cursor';
}

export function emitHook(payload, shape) {
    const out = { ...payload };
    if (shape === 'antigravity') {
        if (out.permission === 'deny') {
            process.stdout.write(
                `${JSON.stringify({
                    decision: 'deny',
                    reason: out.user_message || out.agent_message || 'denied',
                })}\n`,
            );
            return;
        }
        if (out.permission === 'allow') {
            process.stdout.write('{"decision":"allow"}\n');
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

export function allow(shape, extra = {}) {
    emitHook({ permission: 'allow', ...extra }, shape);
}

export function deny(shape, message, extra = {}) {
    emitHook(
        {
            permission: 'deny',
            user_message: message,
            agent_message: message,
            ...extra,
        },
        shape,
    );
}

export function extractShellCommand(data) {
    if (!data || typeof data !== 'object') return '';
    const direct = data.command;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const call = typeof data.toolCall === 'object' ? data.toolCall : {};
    const name = String(call.name || '');
    const args = typeof call.args === 'object' ? call.args : {};
    for (const key of ['command', 'Command', 'cmd', 'script', 'input', 'text']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    if (name && SHELL_TOOL_RE.test(name)) {
        return String(args.command || args.Command || '').trim();
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
