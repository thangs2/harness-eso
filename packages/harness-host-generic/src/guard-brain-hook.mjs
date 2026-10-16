/**
 * Brain guard — `preToolUse`. Blocks Brain MCP when ESO gaps are open
 * (`eso.cognition.enforceBrain`).
 */
import {
    allow,
    deny,
    detectShape,
    extractToolMeta,
    loadPolicyForCwd,
    readStdin,
} from './hook-io.mjs';
import { readGapClosure, readPreflight, shouldBlockBrain } from './eso-gap-io.mjs';

const BRAIN_TOOL_RE = /ask_deepseek|deepseek-v4|deepseek_direct|project-0-x79-deepseek/i;

function isBrainTool(toolName, toolInput) {
    const name = String(toolName || '');
    if (BRAIN_TOOL_RE.test(name)) return true;
    if (/^CallDynamicTool$/i.test(name)) {
        const ns =
            toolInput?.namespace ||
            toolInput?.mcpDetails?.namespace ||
            toolInput?.server ||
            '';
        const tool = toolInput?.toolName || toolInput?.tool || '';
        return BRAIN_TOOL_RE.test(`${ns}/${tool}`);
    }
    if (/^call_mcp_tool$/i.test(name)) {
        const server = toolInput?.ServerName || toolInput?.serverName || '';
        const tool = toolInput?.ToolName || toolInput?.toolName || '';
        return BRAIN_TOOL_RE.test(`${server}/${tool}`);
    }
    return false;
}

export async function run() {
    let data = {};
    let shape = 'cursor';
    try {
        const raw = await readStdin();
        data = raw.trim() ? JSON.parse(raw) : {};
        shape = detectShape(data);
    } catch {
        allow(shape);
        return;
    }

    const { toolName, toolInput } = extractToolMeta(data);
    if (!isBrainTool(toolName, toolInput)) {
        allow(shape);
        return;
    }

    const { policy } = loadPolicyForCwd();
    const pre = readPreflight();
    const closure = readGapClosure();
    if (!shouldBlockBrain(pre, closure, policy)) {
        allow(shape, { brainGuard: 'ok' });
        return;
    }

    const level = pre?.level || 'partial';
    deny(
        shape,
        `ESO cognition guard: Brain MCP blocked until gap closure (${level}). Run recon tools from the preflight playbook, then retry.`,
        { esoBrainBlocked: true, level },
    );
}
