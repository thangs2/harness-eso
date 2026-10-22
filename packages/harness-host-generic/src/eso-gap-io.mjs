import { isoNow, projectIdFrom, writeEsoAttestation } from '@mu/harness-foundation/pure';
import { harnessTree, readJsonFile, sessionDir, writeJsonFile } from './hook-io.mjs';
import path from 'node:path';

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

/**
 * Paths that hold agent instructions, harness state or dependencies rather than project source.
 *
 * Reading one of these is real recon — it is how the agent learns the rules — but it is not evidence
 * that **this project's** code was inspected, which is what the read-count gap claims to measure.
 */
const NON_SOURCE_SEGMENTS = [
    '.cursor',
    '.agents',
    '.claude',
    '.harness',
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.round-cost',
];

function isNonSourcePath(rel) {
    return rel.split('/').some((seg) => NON_SOURCE_SEGMENTS.includes(seg.toLowerCase()));
}

/**
 * Whether a read path proves project source was inspected (H5).
 *
 * Three layers, and the third is deliberate: a path must be inside the preflight root, must not be
 * harness/skill/dependency material, and — unlike the naive fix — is **not** required to match
 * `codeQueries`. The `tools` pack lists `tools/harness`, so requiring it would reject
 * `packages/harness-host-generic/src/…`, which is exactly the source a `tools` turn is about.
 *
 * @param {string|null} filePath
 * @param {{ root?: string, codeQueries?: string[] }} [opts]
 */
export function isProjectSourcePath(filePath, opts = {}) {
    if (!filePath) return false;
    const raw = String(filePath).trim();
    if (!raw) return false;

    const root = opts.root ? path.resolve(opts.root) : null;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : root ? path.resolve(root, raw) : null;

    if (root && abs) {
        const relToRoot = path.relative(root, abs);
        if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return false;
    }

    const rel = root && abs ? path.relative(root, abs) : raw;
    const normalised = rel.split(path.sep).join('/').replace(/^\.\//, '');
    if (!normalised || normalised === '' || normalised === '.') return false;
    if (isNonSourcePath(normalised)) return false;

    return true;
}

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

export function closesGap(gap, kinds, toolInput, toolName = '', opts = {}) {
    const kind = gap?.kind || 'other';
    if (!kinds.has(kind)) {
        if (kind === 'symbol' && kinds.has('code')) return true;
        if (kind === 'doc' && kinds.has('law')) return true;
        return false;
    }
    const query = String(gap?.query || '');
    if (kind === 'code' && READ_COUNT_GAP_RE.test(query)) {
        if (isProjectSourcePath(extractFilePath(toolInput), opts)) return true;
        const blob = (String(toolName || '') + ' ' + JSON.stringify(toolInput || {})).toLowerCase();
        if (CODEGRAPH_RE.test(blob)) {
            const cgQuery = toolInput?.query ?? toolInput?.arguments?.query ?? toolInput?.symbol ?? toolInput?.arguments?.symbol;
            if (typeof cgQuery === 'string' && cgQuery.trim().length > 0) return true;
        }
        return false;
    }
    const target = String(gap?.query || gap?.path || '').toLowerCase();
    if (!target || target === '?') return true;
    return stemMatches(target, toolInput, toolName);
}

/**
 * Fold the separators consumers actually use in rule names, so one term matches one file.
 *
 * A law gap's query is a bare term from `skillPacks.<bucket>.lawQueries` — `pipeline-gate`. The
 * artifact the consumer can read is `.cursor/rules/core.pipeline-gate.mdc`. The `.` after `core`
 * breaks a raw substring test, and **every** consumer rule is named `core.*` / `stack.*` /
 * `delivery.*`, so no consumer could close a law gap by reading the law that answers it (H1). Only
 * accidental closures were ever observed: a `Grep` whose *pattern* text happened to contain the term,
 * or a path in a different repo.
 *
 * Folding `.`, `-` and `_` to one separator on both sides is the whole fix. It is deliberately **not**
 * a bare-segment match: `pipeline-gates-archive` must not satisfy `pipeline-gate`.
 */
function foldStem(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[._\-/]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The basename of whatever path the tool input carries, otherwise the whole argument blob. */
function stemHaystack(toolInput, toolName) {
    const filePath = extractFilePath(toolInput);
    if (filePath) return foldStem(String(filePath).split(/[\\/]/).pop());
    return foldStem(JSON.stringify(toolInput || {}));
}

/**
 * Doc stems a path "is", most specific first: the basename, then any dot-separated tail of it.
 *
 * A law gap's query is a bare term from `skillPacks.<bucket>.lawQueries` — `pipeline-gate` — while
 * the artifact the consumer can read is `.cursor/rules/core.pipeline-gate.mdc`. Comparing whole
 * basenames never equalled the term, and **every** consumer rule is named `core.*` / `stack.*` /
 * `delivery.*`, so no consumer could close a law gap by reading the law that answers it (H1).
 *
 * Expanding a dotted basename is what makes one term match one file. Matching is still exact per
 * stem — `pipeline-gate` is one of the stems of `core.pipeline-gate.mdc` and *not* one of
 * `pipeline-gates.mdc` or `pipeline-gateways.md`, so a similarly named rule cannot close it.
 *
 * @param {string} filePath
 * @returns {string[]} folded stems, longest first
 */
function pathStems(filePath) {
    const base = String(filePath || '')
        .split(/[\\/]/)
        .pop();
    if (!base) return [];
    const withoutExt = base.replace(/\.[A-Za-z0-9]+$/, '');
    const parts = withoutExt.split(/[._\-]+/).filter(Boolean);
    const stems = new Set();
    for (let i = 0; i < parts.length; i += 1) {
        const stem = foldStem(parts.slice(i).join('-'));
        if (stem) stems.add(stem);
    }
    return [...stems].sort((a, b) => b.length - a.length);
}

function stemMatches(target, toolInput, toolName) {
    const foldedTarget = foldStem(target);
    if (!foldedTarget) return false;
    const filePath = extractFilePath(toolInput);
    /*
     * A term can name a document (`AGENTS.md`, `pipeline-gate`, `source`) or ask for a kind of source
     * (`code`). Reading a real file proves the first case; it says nothing about the second, and
     * deciding on the file alone would leave that gap unclosable.
     */
    let satisfied = false;
    if (filePath) {
        const base = String(filePath).split(/[\\/]/).pop();
        const withoutExt = base.replace(/\.[A-Za-z0-9]+$/, '');
        satisfied =
            foldStem(base) === foldedTarget ||
            foldStem(withoutExt) === foldedTarget ||
            pathStems(filePath).includes(foldedTarget);
    }
    const hay = stemHaystack(toolInput, toolName);
    if (`-${hay}-`.includes(`-${foldedTarget}-`)) satisfied = true;
    // Slash-separated queries (`backend/mu-`) target a prefix rather than a single token.
    if (
        target
            .split('/')
            .filter((seg) => seg.length > 3)
            .some((seg) => `-${hay}-`.includes(`-${foldStem(seg)}-`))
    ) {
        satisfied = true;
    }
    return satisfied;
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
    const matchOpts = { root, codeQueries: pre.pack?.codeQueries };
    for (const g of gaps) {
        const id = gapId(g);
        if (closed.has(id)) continue;
        if (closesGap(g, kinds, toolInput, toolName, matchOpts)) closed.add(id);
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

    /*
     * Rewrite the stamp on **every** transition, not only the last one (H3).
     *
     * `guard-write.py` reads the attestation, and the attestation was written only from the
     * `allClosed` branch, so partial progress was invisible to the gate: one file said `1 of 2
     * closed`, the other still said `insufficient`. It also made a stuck gap indistinguishable from
     * a turn that had done nothing.
     *
     * The score is **re-measured** from the closure (H2). It used to be
     * `Math.max(pre.score, 0.85)` — a constant, so an `85` meant "the right words appeared in a tool
     * argument" and was indistinguishable from a measured one. `scoreFromClosure` keeps the
     * preflight's law/read split and replaces only the closed fraction, so the number stays on the
     * same scale the gates compare against `T_low` / `T_high`.
     */
    if (pre) {
        const measured = scoreFromClosure(pre, doc, opts.policy);
        const allowWrite = doc.allClosed && measured.level === 'sufficient';
        try {
            writeBundleStampFromPreflight(
                {
                    ...pre,
                    at: pre.at,
                    allowWrite,
                    level: measured.level,
                    score: measured.score,
                    updatedAt: doc.at,
                    closure: {
                        closed: closedGapIds.length,
                        required: required.length,
                        allClosed: doc.allClosed,
                    },
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

/**
 * Re-measure sufficiency from the gaps that are actually closed.
 *
 * Deliberately not `closed / required`: the shipped score is `lawRatio * 0.55 + readRatio * 0.45`,
 * compared against `T_low` / `T_high`, so a fraction of closed gaps is on a different scale and would
 * read as `partial` at best. Every `law` gap belongs to the law ratio and every `code` read-count gap
 * to the read ratio; the preflight's own split between the two is kept.
 *
 * @param {object} pre     the preflight document
 * @param {object} doc     the closure document after this tool call
 * @param {object} [policy]
 * @returns {{ score: number, level: string }}
 */
export function scoreFromClosure(pre, doc, policy = {}) {
    const required = Array.isArray(doc?.requiredGapIds) ? doc.requiredGapIds : [];
    const closed = new Set(doc?.closedGapIds || []);
    const gaps = Array.isArray(pre?.gaps) ? pre.gaps : [];
    const lawGaps = gaps.filter((g) => g.kind === 'law');
    const codeGaps = gaps.filter((g) => g.kind === 'code');

    const lawClosed = lawGaps.filter((g) => closed.has(gapId(g))).length;
    const codeClosed = codeGaps.filter((g) => closed.has(gapId(g))).length;
    const lawRatio = lawGaps.length ? lawClosed / lawGaps.length : 1;
    const readRatio = codeGaps.length ? codeClosed / codeGaps.length : 1;

    // A preflight that measured 0 while its pack required nothing has no law/read split to keep.
    const hasSplit = lawGaps.length > 0 || codeGaps.length > 0;
    const measured = hasSplit ? lawRatio * 0.55 + readRatio * 0.45 : Number(pre?.score ?? 0);
    const score = Math.max(0, Math.min(1, measured));

    const thresholds = policy?.eso?.thresholds || {};
    const T_low = Number(thresholds.T_low ?? 0.45);
    const T_high = Number(thresholds.T_high ?? 0.72);
    const allClosed = required.length === 0 || required.every((id) => closed.has(id));

    let level = 'insufficient';
    if (score >= T_high && allClosed) level = 'sufficient';
    else if (score >= T_low) level = 'partial';

    return { score: Number(score.toFixed(4)), level };
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
        // Whether this verdict is the initial measurement or one taken as gaps closed (H3). A reader
        // comparing the stamp with the closure file needs to know which instant it describes.
        ...(preflight.closure ? { closure: preflight.closure, updatedAt: preflight.updatedAt ?? null } : {}),
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
                fingerprint: preflight.fingerprint ?? null,
                invIds: preflight.pinnedInvariants ?? preflight.invIds ?? [],
                ttlSec: preflight.ttlSec ?? 600,
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
