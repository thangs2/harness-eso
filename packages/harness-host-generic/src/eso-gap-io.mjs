import { isoNow } from '@mu/harness-foundation/pure';
import { harnessTree, readJsonFile, sessionDir, writeJsonFile } from './hook-io.mjs';

const READ_TOOL_RE = /^(Read|Grep|Glob|CallDynamicTool)$/i;
const CODEGRAPH_RE = /codegraph/i;
const MEMORY_RE = /memory_smart|memory_recall|agentmemory/i;
const DOCGRAPH_RE = /docgraph/i;

export function gapId(gap) {
    const kind = gap?.kind || 'other';
    const target = gap?.query || gap?.path || gap?.id || '?';
    return `${kind}:${target}`;
}

export function preflightPath(root = process.cwd(), tree = harnessTree()) {
    return `${sessionDir(root, tree)}/.eso-preflight.json`;
}

export function gapClosurePath(root = process.cwd(), tree = harnessTree()) {
    return `${sessionDir(root, tree)}/.eso-gap-closure.json`;
}

export function bundleStampPath(root = process.cwd(), tree = harnessTree()) {
    return `${sessionDir(root, tree)}/.eso-bundle-stamp.json`;
}

export function readPreflight(root = process.cwd(), tree = harnessTree()) {
    return readJsonFile(preflightPath(root, tree));
}

export function readGapClosure(root = process.cwd(), tree = harnessTree()) {
    return readJsonFile(gapClosurePath(root, tree));
}

export function resetGapClosure(preflightAt, root = process.cwd(), tree = harnessTree()) {
    const pre = readPreflight(root, tree);
    const gaps = Array.isArray(pre?.gaps) ? pre.gaps : [];
    const doc = {
        ok: true,
        at: isoNow(),
        preflightAt: preflightAt || pre?.at || null,
        requiredGapIds: gaps.map(gapId),
        closedGapIds: [],
        toolUses: [],
    };
    writeJsonFile(gapClosurePath(root, tree), doc);
    return doc;
}

function gapKindsForTool(toolName, toolInput) {
    const name = String(toolName || '');
    const blob = JSON.stringify(toolInput || {}).toLowerCase();
    const kinds = new Set();
    if (READ_TOOL_RE.test(name) || name === 'Shell') {
        kinds.add('law');
        kinds.add('code');
        kinds.add('check');
    }
    if (CODEGRAPH_RE.test(name) || CODEGRAPH_RE.test(blob)) kinds.add('code', 'symbol');
    if (MEMORY_RE.test(name) || MEMORY_RE.test(blob)) kinds.add('memory');
    if (DOCGRAPH_RE.test(name) || DOCGRAPH_RE.test(blob)) kinds.add('law', 'doc');
    if (/^Grep$/i.test(name)) kinds.add('code', 'law', 'doc');
    return kinds;
}

function closesGap(gap, kinds, toolInput) {
    const kind = gap?.kind || 'other';
    if (!kinds.has(kind)) {
        if (kind === 'symbol' && kinds.has('code')) return true;
        if (kind === 'doc' && kinds.has('law')) return true;
        return false;
    }
    const target = String(gap?.query || gap?.path || '').toLowerCase();
    if (!target || target === '?') return true;
    const hay = JSON.stringify(toolInput || {}).toLowerCase();
    return hay.includes(target) || target.split('/').some((seg) => seg.length > 3 && hay.includes(seg));
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [opts]
 */
export function recordGapToolUse(toolName, toolInput, opts = {}) {
    const root = opts.root || process.cwd();
    const tree = opts.tree || harnessTree();
    const pre = readPreflight(root, tree);
    if (!pre?.at) return null;

    let closure = readGapClosure(root, tree);
    if (!closure || closure.preflightAt !== pre.at) {
        closure = resetGapClosure(pre.at, root, tree);
    }

    const kinds = gapKindsForTool(toolName, toolInput);
    const gaps = Array.isArray(pre.gaps) ? pre.gaps : [];
    const closed = new Set(closure.closedGapIds || []);
    for (const g of gaps) {
        const id = gapId(g);
        if (closed.has(id)) continue;
        if (closesGap(g, kinds, toolInput)) closed.add(id);
    }

    const toolUses = Array.isArray(closure.toolUses) ? [...closure.toolUses] : [];
    toolUses.push({
        at: isoNow(),
        tool: String(toolName || ''),
        path: String(toolInput?.path || toolInput?.file_path || ''),
    });
    if (toolUses.length > 32) toolUses.splice(0, toolUses.length - 32);

    const required = gaps.map(gapId);
    const closedGapIds = [...closed].filter((id) => required.includes(id));
    const doc = {
        ...closure,
        ok: true,
        at: isoNow(),
        preflightAt: pre.at,
        requiredGapIds: required,
        closedGapIds,
        allClosed: required.length === 0 || closedGapIds.length >= required.length,
        toolUses,
    };
    writeJsonFile(gapClosurePath(root, tree), doc);
    return doc;
}

export function resolveEnforceBrain(policy) {
    const raw = policy?.eso?.cognition?.enforceBrain;
    if (raw === 'off' || raw === false) return 'off';
    if (raw === 'fail_closed' || raw === true) return 'fail_closed';
    return 'fail_closed';
}

export function shouldBlockBrain(preflight, closure, policy) {
    if (process.env.HARNESS_ESO === '0') return false;
    if (resolveEnforceBrain(policy) === 'off') return false;
    if (!preflight?.at) return false;
    const level = preflight.level || 'partial';
    if (level === 'sufficient') return false;
    const gaps = Array.isArray(preflight.gaps) ? preflight.gaps : [];
    if (!gaps.length) return false;
    if (!closure || closure.preflightAt !== preflight.at) return true;
    if (closure.allClosed === true) return false;
    const required = closure.requiredGapIds || gaps.map(gapId);
    const closed = new Set(closure.closedGapIds || []);
    return required.some((id) => !closed.has(id));
}

export function writeBundleStampFromPreflight(preflight, policy, root = process.cwd(), tree = harnessTree()) {
    if (!preflight) return null;
    const enforceWrites = preflight.enforceWrites ?? policy?.eso?.enforceWrites ?? 'off';
    const esoMode = policy?.eso?.mode ?? 'observe';
    const gateMode =
        enforceWrites === 'fail_closed' || esoMode === 'fail_closed' ? 'fail_closed' : esoMode;
    const payload = {
        ok: true,
        at: isoNow(),
        allowWrite: preflight.allowWrite !== false,
        level: preflight.level ?? 'partial',
        score: preflight.score ?? null,
        mode: gateMode,
        enforceWrites: enforceWrites || null,
        preflightAt: preflight.at || null,
    };
    writeJsonFile(bundleStampPath(root, tree), payload);
    return payload;
}
