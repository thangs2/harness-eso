import { isoNow, projectIdFrom, writeEsoAttestation } from '@mu/harness-foundation/pure';
import { harnessTree, readJsonFile, sessionDir, writeJsonFile } from './hook-io.mjs';

const READ_TOOL_RE = /^(Read|Grep|Glob|CallDynamicTool|view_file|grep_search|find_by_name|call_mcp_tool|mcp__.*)$/i;
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

const READ_COUNT_GAP_RE = /^need at least \d+ file read\(s\); have \d+$/;

function extractFilePath(input) {
    if (!input || typeof input !== 'object') return null;
    const direct =
        input.path ??
        input.file_path ??
        input.target_file ??
        input.TargetFile ??
        input.AbsolutePath ??
        input.SearchPath ??
        input.DirectoryPath ??
        input.targetFile ??
        input.filePath ??
        input.projectPath;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
    if (input.arguments && typeof input.arguments === 'object') {
        const nested =
            input.arguments.path ??
            input.arguments.file_path ??
            input.arguments.target_file ??
            input.arguments.TargetFile ??
            input.arguments.AbsolutePath ??
            input.arguments.SearchPath ??
            input.arguments.DirectoryPath ??
            input.arguments.targetFile ??
            input.arguments.filePath ??
            input.arguments.projectPath;
        if (typeof nested === 'string' && nested.trim().length > 0) return nested.trim();
    }
    return null;
}

export function gapKindsForTool(toolName, toolInput) {
    const name = String(toolName || '');
    const blob = JSON.stringify(toolInput || {}).toLowerCase();
    const kinds = new Set();
    if (READ_TOOL_RE.test(name) || name === 'Shell' || /^run_command$/i.test(name) || name === 'Bash') {
        kinds.add('law');
        kinds.add('code');
        kinds.add('check');
    }
    if (CODEGRAPH_RE.test(name) || CODEGRAPH_RE.test(blob)) {
        kinds.add('code');
        kinds.add('symbol');
    }
    if (MEMORY_RE.test(name) || MEMORY_RE.test(blob)) {
        kinds.add('memory');
    }
    if (DOCGRAPH_RE.test(name) || DOCGRAPH_RE.test(blob)) {
        kinds.add('law');
        kinds.add('doc');
    }
    if (/^(Grep|grep_search)$/i.test(name)) {
        kinds.add('code');
        kinds.add('law');
        kinds.add('doc');
    }
    return kinds;
}

export function closesGap(gap, kinds, toolInput, toolName = '') {
    const kind = gap?.kind || 'other';
    if (!kinds.has(kind)) {
        if (kind === 'symbol' && kinds.has('code')) return true;
        if (kind === 'doc' && kinds.has('law')) return true;
        return false;
    }
    const query = String(gap?.query || '');
    if (kind === 'code' && READ_COUNT_GAP_RE.test(query)) {
        if (extractFilePath(toolInput)) return true;
        const blob = (String(toolName || '') + ' ' + JSON.stringify(toolInput || {})).toLowerCase();
        if (CODEGRAPH_RE.test(blob)) {
            const cgQuery = toolInput?.query ?? toolInput?.arguments?.query ?? toolInput?.symbol ?? toolInput?.arguments?.symbol;
            if (typeof cgQuery === 'string' && cgQuery.trim().length > 0) return true;
        }
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
        if (closesGap(g, kinds, toolInput, toolName)) closed.add(id);
    }

    const toolUses = Array.isArray(closure.toolUses) ? [...closure.toolUses] : [];
    toolUses.push({
        at: isoNow(),
        tool: String(toolName || ''),
        path: extractFilePath(toolInput) || '',
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
    if (doc.allClosed && pre) {
        try {
            writeBundleStampFromPreflight(
                {
                    ...pre,
                    allowWrite: true,
                    level: 'sufficient',
                    score: Math.max(Number(pre.score || 0), 0.85),
                },
                opts.policy || {},
                root,
                tree,
            );
        } catch {
            // non-fatal
        }
    }
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

    /*
     * The same verdict, written where the agent's own Write/Shell path cannot reach.
     *
     * The session stamp above has to stay — every existing guard and the pack's own gap tracker read it,
     * and it is the pack's legitimate output. But it is one directory away from files the agent must be
     * able to write (the Brain stamp lives beside it), so the agent can overwrite it, and one did: an
     * incident had the agent replace `allowWrite: false` with `true`, and invent a score and a
     * `hilWaiver`. Product state is guarded by both `guard-write.py` and `guard-shell.py`, so the agent's
     * ordinary channels are shut for this copy. The guard prefers it; see `attest.mjs`.
     */
    try {
        const projectId = projectIdFrom(root);
        if (projectId) {
            writeEsoAttestation(projectId, {
                at: payload.at,
                generationId: preflight.generationId ?? null,
                level: payload.level,
                score: payload.score,
                allowWrite: payload.allowWrite,
                enforceWrites: payload.enforceWrites,
                mode: payload.mode,
            });
        }
    } catch {
        /*
         * Preflight must never fail because the attestation could not be written: `root` may be a repo
         * with no `harness.config.json`, and product state may be read-only in a container. The guard
         * falls back to the session stamp, which is the behaviour that existed before this.
         */
    }
    return payload;
}
