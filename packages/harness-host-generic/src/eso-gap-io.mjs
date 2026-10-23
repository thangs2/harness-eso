import { isoNow, projectIdFrom, writeEsoAttestation } from '@mu/harness-foundation/pure';
import { harnessTree, readJsonFile, sessionDir, writeJsonFile } from './hook-io.mjs';
import path from 'node:path';

const READ_TOOL_RE = /^(Read|Grep|Glob|CallDynamicTool|view_file|grep_search|find_by_name|call_mcp_tool|mcp__.*)$/i;
const CODEGRAPH_RE = /codegraph/i;
const MEMORY_RE = /memory_smart|memory_recall|agentmemory/i;
const DOCGRAPH_RE = /docgraph/i;
/**
 * Tools whose *purpose* is to answer a semantic law query.
 *
 * `docgraph --q "<term>"` is the adapter the preflight itself used to raise the gap, so a turn that
 * runs it has asked the same question the gate asked — even when the index cannot answer it, the
 * attempt is the evidence the gate is entitled to score. Nothing else may claim that: a term that
 * happens to appear in some other command's arguments is not a reading of the law (P-01).
 */
const LAW_QUERY_TOOL_RE = /^(docgraph|Grep|grep_search)$/i;

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

/**
 * Where a consumer's **non-answers** are remembered (G-13).
 *
 * Product state, not the session dir: the fact being stored is about the repo ("this corpus has no
 * document for this term"), which outlives the session that discovered it — and the session dir is one
 * the agent can write, so a stored non-answer there would be a gate input the gated party owns.
 */
export function lawMissPath(root = process.cwd()) {
    return path.join(String(root || process.cwd()), '.harness', 'law-misses.json');
}
const LAW_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Terms this repo answered with nothing, within the TTL, keyed by the query the pack asked.
 *
 * Deliberately **not** a cache of evidence: only the absence is remembered, and only to change what the
 * preflight *reports*. Every turn still asks the adapter (E2 allows skipping derived work, not
 * measurement), so an index rebuild is noticed on the next turn without any invalidation hook.
 *
 * @returns {Record<string, {missedAt: string, adapterTrace?: string}>}
 */
export function readLawMisses(root = process.cwd(), now = Date.now()) {
    const doc = readJsonFile(lawMissPath(root));
    const terms = doc?.terms;
    if (!terms || typeof terms !== 'object') return {};
    const fresh = {};
    for (const [term, entry] of Object.entries(terms)) {
        const at = Date.parse(entry?.missedAt || '');
        if (!Number.isFinite(at) || now - at > LAW_MISS_TTL_MS) continue;
        fresh[term] = entry;
    }
    return fresh;
}

/**
 * Record this turn's misses and forget the terms that answered this time.
 *
 * Forget, don't merge, on success: a term that produced rows is no longer unanswerable, and keeping the
 * old row would make the next preflight report a stale non-answer as current.
 */
export function rememberLawMisses(root, misses, answered = []) {
    const file = lawMissPath(root);
    const now = new Date().toISOString();
    const terms = readLawMisses(root);
    for (const m of misses || []) terms[m] = { missedAt: now };
    for (const a of answered || []) delete terms[a];
    try {
        writeJsonFile(file, { ok: true, updatedAt: now, terms });
    } catch {
        // Product state may be read-only (a container); the gate must not fail because of a hint.
    }
    return terms;
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

/**
 * Fold a new preflight into the closure already on disk, without discarding work (P-28).
 *
 * `resetGapClosure` used to be called on every preflight, and `beforeSubmitPrompt` runs preflight on
 * **every** submit — so each new prompt truncated the closure file back to `closedGapIds: []`. The
 * file lives at a session path but behaved per-generation, and `fineso` measured the damage: 32 real
 * rows became 0 on the next refire, and a read-only probe was blamed for a wipe the design performs.
 *
 * Rules:
 *   - a gap that is still required keeps its closed state;
 *   - a gap no longer required is dropped from `closedGapIds`;
 *   - a **new** gap id is recorded as reopened, so a reader can tell "the preflight found more to do"
 *     from "the agent made progress".
 *
 * A different conversation is a different turn and does reset — that is the one boundary where the
 * old behaviour was right.
 *
 * @param {object} preflight  the projection just written
 * @param {string} [root]
 * @param {string} [tree]
 * @returns {object}
 */
export function mergeGapClosure(preflight, root = process.cwd(), tree = harnessTree()) {
    const previous = readGapClosure(root, tree);
    const fresh = resetGapClosure(preflight?.at, root, tree);
    const sameSession =
        !previous?.conversationId ||
        !preflight?.conversationId ||
        previous.conversationId === preflight.conversationId;

    if (!previous || !sameSession || !Array.isArray(previous.toolUses)) {
        const doc = { ...fresh, conversationId: preflight?.conversationId ?? previous?.conversationId ?? null };
        writeJsonFile(gapClosurePath(root, tree), doc);
        return doc;
    }

    const required = new Set(fresh.requiredGapIds);
    const previouslyClosed = Array.isArray(previous.closedGapIds) ? previous.closedGapIds : [];
    const closedGapIds = previouslyClosed.filter((id) => required.has(id));
    const previouslyRequired = new Set(previous.requiredGapIds || []);
    const reopenedGapIds = [...required].filter((id) => !previouslyRequired.has(id));

    const doc = {
        ...fresh,
        closedGapIds,
        toolUses: previous.toolUses,
        conversationId: preflight?.conversationId ?? previous.conversationId ?? null,
        ...(reopenedGapIds.length ? { reopenedGapIds, reopenedBy: 'preflight-refire' } : {}),
        allClosed: required.size === 0 || closedGapIds.length >= required.size,
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

/**
 * Extensions a "file read" may count as project source.
 *
 * The gap comes from a pack whose `codeQueries` name directories, and the honest reading of "read at
 * least one source file" is *code*: a `.sh` CI helper, a `.md` document or a `.json` config is real
 * recon but is not the source the gap is about. Before this list the check was "any path that is not
 * a rule directory", so reading `scripts/ci/*.sh` closed the code gap while the agent had inspected
 * none of the code it was about to change.
 *
 * Deliberately a allow-list rather than a deny-list: a new non-code extension (`.lock`, `.snap`,
 * `.sql`) should not need an entry to stay out, and a new *code* extension is a visible edit here.
 */
const SOURCE_EXTENSIONS = [
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
    '.rb', '.php', '.cs', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp',
    '.vue', '.svelte', '.astro',
    '.sh', '.bash', '.zsh',
    '.sql',
];

function isNonSourcePath(rel) {
    return rel.split('/').some((seg) => NON_SOURCE_SEGMENTS.includes(seg.toLowerCase()));
}

/**
 * Segments that hold harness **state** — the pack's own cache, session files and database.
 *
 * Narrower than `NON_SOURCE_SEGMENTS` and used only where the question is "is this an artefact the
 * agent produced or the harness cached" rather than "is this project source". The docgraph cache is
 * the case that matters: it contains the query text verbatim, so reading it answers a law question
 * with the answer the harness itself wrote (P-02).
 */
const HARNESS_STATE_SEGMENTS = ['.harness', '.git', 'node_modules', '.round-cost'];

function isHarnessStatePath(rel) {
    return rel.split('/').some((seg) => HARNESS_STATE_SEGMENTS.includes(seg.toLowerCase()));
}

function hasSourceExtension(rel) {
    const lower = rel.toLowerCase();
    return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Whether a read path proves project source was inspected (H5).
 *
 * Four layers: a path must be inside the preflight root, must not be harness/skill/dependency
 * material, must carry a source-code extension, and — unlike the naive fix — is **not** required to
 * match `codeQueries`. The `tools` pack lists `tools/harness`, so requiring it would reject
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
    if (!hasSourceExtension(normalised)) return false;

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
        /*
         * (iii) A Shell/Grep call that **touched** a source file: the three shapes a read takes when it
         * goes through a command instead of the Read tool.
         *
         * `fineso` measured the hole this closes: 16 `Read` calls (all `.md`, `.py` under `.cursor`, or
         * outside root) plus 75 Shell commands inspecting the tree closed zero — a read-only diagnostic
         * is *structurally* unable to reach `sufficient`, so the score measures tool choice, not
         * evidence (P-04). A command that opens, lists or greps a source path is the same recon.
         */
        return shellTouchedSource(toolInput, opts);
    }
    /*
     * A gap's target may name the inspection itself — `view_file src/index.ts`, `Read AGENTS.md`. The
     * tool prefix is the instrument, not the artifact: only the path after it is the document whose
     * reading closes the gap. Without this strip, the stricter query reading (P-01) also stopped the
     * legitimate `view_file` closure that the receipt test pins.
     */
    const target = String(gap?.query || gap?.path || '')
        .toLowerCase()
        .replace(/^[a-z_][a-z0-9_]*[:\s]+(?=[\w./-])/, '');
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
 * The semantic query a tool call carried, when the tool is one whose purpose is to ask it.
 *
 * Two shapes matter, and they are the only two a closure may read from a **no-path** call (P-01):
 *
 *   - MCP tools put the argument under `arguments` (`Grep {pattern}`, `CallDynamicTool {name,arguments:{query}}`);
 *   - Shell carries it inside a command string (`docgraph --q "pipeline-gate"`, `rg -n "pipeline-gate" x.md`).
 *
 * Returning `null` — not the whole blob — is the point: everything else in a tool's arguments is
 * context, not a question. Reading the blob is what let `rg …pipeline-gate` over a comment close the
 * gap, and what let a `.harness/cache` hit stand in for the law (P-02).
 *
 * @param {object} toolInput
 * @param {string} toolName
 * @returns {string|null} the query text, un-folded
 */
function extractedQuery(toolInput, toolName) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const name = String(toolName || '');
    const args = toolInput.arguments && typeof toolInput.arguments === 'object' ? toolInput.arguments : {};
    /*
     * No `symbol` here on purpose: a symbol name is not a law term, and reading it let a codegraph
     * lookup close a semantic law gap when the lookup happened to name the right word. `name` is read
     * only as a selector (`CallDynamicTool {name: 'Grep', arguments: {pattern}}`), never as the query.
     */
    const direct = toolInput.query ?? toolInput.pattern ?? args.query ?? args.pattern;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    // Shell: only the argument of the tool that asks a law question, never the whole command.
    const command = toolInput.command ?? toolInput.cmd ?? toolInput.script;
    if (typeof command !== 'string' || !command.trim()) return null;
    /*
     * `docgraph --q "<term>"` is the semantic question. A `grep`/`rg` argument is a regex over file
     * text, so it is the question only when `pattern` names it (handled above) — a Shell `grep -n
     * "pipeline-gate" docgraph.scope` searches a *file*, not the law, and closed the gap on
     * `baplatform` for exactly that reason (P-01).
     */
    if (!LAW_QUERY_TOOL_RE.test(name) && !/\bdocgraph\b/.test(command)) return null;
    const m = command.match(/--q(?:uery)?[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/);
    if (!m) return null;
    const cleaned = String(m[1] ?? m[2] ?? m[3] ?? '').trim();
    return cleaned || null;
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
    /*
     * Only a path that names a **file** answers "which document is this"; `Grep {path: 'sdlc'}` carries
     * a directory, and treating it as the document left the pattern unread (it closed nothing, or —
     * worse — a directory named after the term would close it).
     */
    const rawPath = extractFilePath(toolInput);
    const filePath = rawPath && /[^/\\]\.[A-Za-z0-9]+$/.test(String(rawPath)) ? rawPath : null;
    /*
     * A term can name a document (`AGENTS.md`, `pipeline-gate`, `source`) or ask for a kind of source
     * (`code`). Reading a real file proves the first case; it says nothing about the second, and
     * deciding on the file alone would leave that gap unclosable.
     */
    if (filePath) {
        /*
         * Harness state is not law (P-02). `.harness/cache/docgraph/<hash>.txt` holds the *text* the
         * adapter already fetched, including the query string, so a Read of it closed `law:pipeline-gate`
         * without the rule ever being opened. Only harness-state segments are excluded here, not every
         * non-source one: a rule under `.cursor/rules/` is law even though it is not project source, and
         * excluding `.cursor` too would make the H1 case unclosable.
         */
        if (isHarnessStatePath(toRel(filePath))) return false;
        /*
         * A target may carry a directory (`view_file src/index.ts`), so compare folded paths too: the
         * a match is the same document whether the gap named it by basename or by path.
         */
        const foldedPath = foldStem(filePath);
        const targetPath = foldStem(target);
        if (foldedPath === targetPath || foldedPath.endsWith(`-${targetPath}`)) return true;
        const base = String(filePath).split(/[\\/]/).pop();
        const withoutExt = base.replace(/\.[A-Za-z0-9]+$/, '');
        return (
            foldStem(base) === foldedTarget ||
            foldStem(withoutExt) === foldedTarget ||
            pathStems(filePath).includes(foldedTarget)
        );
    }
    /*
     * No path: the only evidence is the **question** the tool asked, and only for the tools that ask
     * one (P-01). The old branch folded the entire argument blob, so any payload containing the term —
     * a `rg` over a scope file's comment, a `jq` over harness state, a path in another repo — closed a
     * semantic law gap. Preflight then emitted `sufficient / 1.00 / allowWrite:true` for a turn that had
     * read no law at all (baplatform, 2026-10-23).
     */
    const asked = extractedQuery(toolInput, toolName);
    if (!asked) return false;
    const hay = foldStem(asked);
    if (`-${hay}-`.includes(`-${foldedTarget}-`)) return true;
    // Slash-separated queries (`backend/mu-`) target a prefix rather than a single token.
    return target
        .split('/')
        .filter((seg) => seg.length > 4)
        .some((seg) => `-${hay}-`.includes(`-${foldStem(seg)}-`));
}

/** Repo-relative form of a path for segment checks; absolute and `./`-prefixed forms both occur. */
function toRel(filePath) {
    return String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
}

/**
 * Did a command token that names a source file inside the preflight root appear in this call?
 *
 * Deliberately lexical and side-effect free: the pack runs in the IDE's hook process and must not
 * stat every file the agent mentions. The token has to look like a path with a source extension, so
 * `rg -n "supports" src/` (directory only) does not count while `sed -n '1,40p' src/server.mjs`
 * does. A query gap is about *inspection*, not about which tool performed it (P-04).
 *
 * @param {object} toolInput
 * @param {{ root?: string }} [opts]
 */
/**
 * Did this Shell command inspect a source file *in the project*? (P-04)
 *
 * Two defects were measured on `fineso`, and both must be excluded here:
 *
 *  - **P-31** — a path inside data is not an inspection. `echo '{"path":"src/app.mjs"}' | jq …` and
 *    `curl -d '{"file":"src/x.ts"}'` name a file the command never opens; counting them let a payload
 *    pay a read gap.
 *  - **P-04** — the contrary mistake (counting only `Read` tool calls) left a read-only audit
 *    unmeasurable, so inspection via `sed`/`rg`/`cat`/`head`/`node -e` must count.
 *
 * The rule is therefore: the command must *read* (a reader binary, or shell redirection) and the path
 * must not be inside a quoted data blob.
 */
const READER_BIN_RE = /(?:^|[;|&(]\s*)(?:cat|bat|sed|awk|head|tail|less|more|rg|grep|node|bun|deno|python3?|jq|wc|diff|nl)\b/;

function stripQuotedData(command) {
    // Drop single/double-quoted spans that look like data (JSON, SQL, HTML) but keep quoted paths.
    return String(command).replace(/'([^']*)'|"([^"]*)"/g, (whole, a, b) => {
        const body = String(a ?? b ?? '');
        return /[{}<>:=]|,\s*"/.test(body) ? ' ' : whole;
    });
}

function shellTouchedSource(toolInput, opts = {}) {
    if (!toolInput || typeof toolInput !== 'object') return false;
    const command =
        toolInput.command ?? toolInput.cmd ?? toolInput.script ?? toolInput.arguments?.command ?? toolInput.arguments?.cmd;
    if (typeof command !== 'string' || !command.trim()) return false;
    if (!READER_BIN_RE.test(command) && !/[<>]\s*\S+\.[A-Za-z0-9]+/.test(command)) return false;
    const searchable = stripQuotedData(command);
    const tokens = searchable.match(/[A-Za-z0-9_./~*-]+\.[A-Za-z0-9]+(?::\d+(?:,\d+)?)?/g) || [];
    for (const token of tokens) {
        const clean = token.replace(/:\d+(?:,\d+)?$/, '');
        if (isProjectSourcePath(clean, opts)) return true;
    }
    return false;
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
        /*
         * Do not discard what an earlier generation of this session already closed (P-28). The
         * preflight re-fires on every prompt submit, so `resetGapClosure` here truncated real progress
         * on each new message; `mergeGapClosure` keeps the closed ids that are still required and
         * records the ones the new preflight added.
         */
        closure = mergeGapClosure(pre, root, tree);
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
        conversationId: pre.conversationId ?? closure.conversationId ?? null,
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
    /*
     * A gap nothing in this repo can close cannot be a Brain condition either (G-09). `enforceBrain`
     * asks for a reasoning record before a *protected write*, and the record is keyed to evidence; a
     * term the corpus does not contain was making the Brain stamp unreachable on the same terms it
     * made the evidence unreachable — two levers for one unanswerable gap. Register R6: the gap stays
     * in the document and stays visible; it does not gate.
     */
    if (gaps.every((g) => g?.unanswerable === true)) return false;
    /*
     * A closure written for an older generation of the **same** conversation still speaks for this
     * one (P-28): re-firing preflight must not re-arm a Brain block the agent already satisfied.
     */
    const sameSession =
        closure &&
        (!closure.conversationId ||
            !preflight.conversationId ||
            closure.conversationId === preflight.conversationId);
    if (!closure || (!sameSession && closure.preflightAt !== preflight.at)) return true;
    if (closure.allClosed === true) return false;
    const required = closure.requiredGapIds || gaps.map(gapId);
    const closed = new Set(closure.closedGapIds || []);
    return required.some((id) => !closed.has(id));
}

export function writeBundleStampFromPreflight(preflight, policy, root = process.cwd(), tree = harnessTree()) {
    if (!preflight) return null;
    /*
     * The preflight document wins over the policy argument, because it is the verdict this stamp
     * describes. It used to read `preflight.enforceWrites` and then ignore `preflight.mode`
     * entirely, falling to `policy?.eso?.mode ?? 'observe'` — so the caller without a policy wrote
     * the *default* mode over a document that carried the real one. `x79`'s attestation said
     * `observe` while the consumer configured `hint`, and `observe` is the copy `guard-write.py`
     * prefers.
     */
    const enforceWrites = preflight.enforceWrites ?? policy?.eso?.enforceWrites ?? 'off';
    const esoMode = preflight.mode ?? policy?.eso?.mode ?? 'observe';
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
        /*
         * Two facts the deny message needs and the stamp used to drop (G-08, G-02). Both are read from
         * the preflight document: it is the verdict this stamp describes, and re-deriving them here
         * would be a second answer to the same question.
         */
        enforceWritesSource: preflight.enforceWritesSource === 'default' ? 'default' : 'declared',
        unanswerableGaps: Array.isArray(preflight.unanswerableGaps)
            ? preflight.unanswerableGaps.filter((g) => g && typeof g === 'object' && g.id).map((g) => ({ id: String(g.id) }))
            : [],
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
                enforceWritesSource: payload.enforceWritesSource,
                unanswerableGaps: payload.unanswerableGaps,
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
