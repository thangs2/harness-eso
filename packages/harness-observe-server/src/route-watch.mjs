#!/usr/bin/env bun
/**
 * route-watch.mjs — the per-request view-model behind the live feed.
 *
 * WHY THIS EXISTS
 * `build-route-map.mjs` answers "what route is DESIGNED?" — a static DAG built
 * from `.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md`. It cannot answer
 * the question an operator actually asks after sending a request:
 *
 *     "what routine just ran, which rules fired, which skills were used,
 *      which files were touched, what was missed, and was the path wrong?"
 *
 * Those answers only exist PER REQUEST. One user prompt = one `generation_id`,
 * and every hook event carries it, so this module groups the trace by
 * `generation_id` (one user prompt = one generation) and derives conformance
 * checks per turn.
 *
 * This module is a LIBRARY: it exports `buildLive` and binds no port.
 * `server.mjs` imports it, stamps a revision on the result, and pushes it to
 * the browser as the `event: live` SSE frame alongside the REST API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, loadDecisionPolicy } from '@mu/harness-foundation';
import { buildAgentHint, buildEvidenceHint, mergeAgentHints } from './observe-agent-hint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Walk up to harness.config.json rather than counting `../`: this module now lives
// in `src/`, and ROOT is used as TRUTH (it builds the trace paths and the
// repo-relative labels), so a one-level-short guess would read the wrong traces
// instead of failing. The four-level fallback only covers a repo that has no
// config yet, where the caller (server.mjs) has already supplied its own root.
const ROOT = findRepoRoot(HERE) || path.resolve(HERE, '..', '..', '..', '..');
/** Both trees are traced symmetrically; each writes its own session trace. */
const HARNESSES = ['.cursor', '.agents'];

/** Newest-first turn cap and per-turn caps — a trace can grow without bound. */
const MAX_TURNS = 40;
const MAX_STEPS = 300;
const MAX_LIST = 200;

const HEARTBEAT_MS = 15000;

/**
 * Paths the pipeline gate protects: the brain stamp must exist before any of
 * these are written. Used for the `brain-before-protected-write` check.
 */
const PROTECTED = [
    /^AGENTS\.md$/,
    /^\.cursorrules$/,
    /^\.(cursor|agents)\/instructions\.md$/,
    /^frontend\//,
    /^backend\/mu-/,
    /^document\/mu\//,
    /^sdlc\//,
    /^\.(cursor|agents)\/(rules|skills|agents)\//,
];

/**
 * A verify pass. `bun run build` / `bun test` / a type-check are the platform
 * defaults; this tool's own build and verifiers count too, since the harness has
 * no root build script and `refresh.sh` is what actually compiles the artifact.
 */
const VERIFY_RE =
    /\b(bun\s+(run\s+)?(build|test)|tsc\b|npm\s+(run\s+)?(build|test)|vitest|jest|refresh\.sh|verify-app|verify-ingest)\b/;

/**
 * The Read *tool* is the signal for "the agent opened this file".
 * `beforeReadFile` cannot serve that purpose: it fires before an overwrite too,
 * because Cursor reads the current body to compute an edit. It IS useful for the
 * opposite question — its absence means the file was created, not modified.
 */
const READ_RE = /^read/i;

/** Brain calls go through the deepseek MCP tools. */
const BRAIN_RE = /ask_deepseek/i;

/* ------------------------------------------------------------------ helpers */

function traceFiles(repoRoot = ROOT) {
    return HARNESSES.map((harness) => ({
        harness,
        file: path.join(repoRoot, harness, 'session', 'route-trace.jsonl'),
    }));
}

/** Repo-relative, forward-slash path — or null when the path escapes the repo. */
function toRel(p, repoRoot = ROOT) {
    if (typeof p !== 'string' || !p) return null;
    const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
    const rel = path.relative(repoRoot, abs);
    if (!rel || rel.startsWith('..')) return null;
    return rel.split(path.sep).join('/');
}

/** `core.pipeline-gate.mdc` -> `core.pipeline-gate`; skills keep their folder. */
function ruleStem(fp) {
    const s = String(fp || '');
    const b = path.basename(s);
    if (b.endsWith('.mdc')) return b.slice(0, -4);
    if (s.includes('/skills/')) return path.basename(path.dirname(s));
    if (s.includes('/agents/')) return b.replace(/\.md$/, '');
    return b.replace(/\.(md|mdc)$/, '');
}

/** Skill name from a path under `<tree>/skills/<name>/…`, else null. */
function skillOf(rel) {
    const m = /^\.(?:cursor|agents)\/skills\/([^/]+)\//.exec(rel || '');
    return m ? m[1] : null;
}

function globToRe(glob) {
    const g = String(glob || '').trim();
    if (!g) return null;
    const brace = g.match(/\{([^{}]*)\}/);
    if (brace) {
        // Expand `{a,b}` into an alternation of fully compiled patterns.
        const parts = brace[1].split(',').map((alt) =>
            globToRe(g.slice(0, brace.index) + alt + g.slice(brace.index + brace[0].length)),
        );
        return new RegExp(parts.filter(Boolean).map((r) => r.source).join('|'));
    }
    let re = '';
    for (let i = 0; i < g.length; i += 1) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                re += '.*';
                i += 1;
                if (g[i + 1] === '/') i += 1; // `**/` should also match zero folders
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

/** Rule index from the static map: stem -> { globs, alwaysApply, layer, re }. */
function loadRuleIndex(repoRoot = ROOT) {
    const file = [path.join(repoRoot, 'route-graph.json'), path.join(HERE, 'route-graph.json')].find((f) =>
        fs.existsSync(f),
    );
    if (!file) {
        return { present: false, generatedAt: null, rules: new Map() };
    }
    const index = { present: false, generatedAt: null, rules: new Map() };
    try {
        const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
        index.present = true;
        index.generatedAt = graph?.meta?.generatedAt ?? null;
        for (const n of graph?.nodes || []) {
            if (n?.kind !== 'rule') continue;
            const stem = ruleStem(n.path || n.id || n.label || '');
            if (!stem) continue;
            index.rules.set(stem, {
                globs: n.globs || [],
                alwaysApply: !!n.alwaysApply,
                layer: n.layer || '',
                re: (n.globs || []).map(globToRe).filter(Boolean),
            });
        }
    } catch {
        // No static map yet — checks that need globs degrade to "unknown".
    }
    return index;
}

/** Records across both trees, in append order, tagged with their harness. */
function readRecords(files) {
    const records = [];
    const sources = [];
    let bad = 0;
    for (const { harness, file } of files) {
        let raw = '';
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch {
            sources.push({ harness, file, events: 0, present: false });
            continue;
        }
        const lines = raw.split('\n').filter((l) => l.trim());
        for (const line of lines) {
            try {
                const r = JSON.parse(line);
                records.push({ ...r, _harness: harness });
            } catch {
                bad += 1;
            }
        }
        sources.push({ harness, file, events: lines.length, present: true });
    }
    return { records, sources, bad };
}

/* ------------------------------------------------------------- turn builder */

function newTurn(id) {
    return {
        id,
        harnesses: new Set(),
        prompt: '',
        model: '',
        composerMode: '',
        startedAt: '',
        endedAt: '',
        steps: [],
        attachedRulePaths: [],
        attachedRules: new Set(),
        skills: new Set(),
        reads: new Set(),
        // Paths the harness read *content* for. It emits this before an overwrite
        // and NOT before a creation, which is what separates "modified an existing
        // file" from "authored a new one".
        readEvents: new Set(),
        firstEvent: new Map(),
        edits: [],
        tools: {},
        brain: [],
        commands: [],
        events: 0,
        editsCount: 0,
        context: null,
        decisionEvents: [],
        decision: null,
    };
}

function stepOf(r, repoRoot) {
    const tool = r.tool || '';
    const rel = toRel(r.path, repoRoot);
    const detail = [
        tool || null,
        rel || null,
        r.editsCount ? `${r.editsCount} edit(s)` : null,
        (r.ruleFiles || []).length ? `rules: ${(r.ruleFiles || []).map(ruleStem).join(', ')}` : null,
    ]
        .filter(Boolean)
        .join(' · ');
    return { at: r.at || '', event: r.event || 'unknown', detail };
}

export function buildLive({
    root = ROOT,
    files = traceFiles(root),
    ruleIndex = loadRuleIndex(root),
    port = null,
    decisionsByGeneration = null,
    evidenceByGeneration = null,
} = {}) {
    const repoRoot = root || ROOT;
    const { records, sources, bad } = readRecords(files);
    const { policy } = loadDecisionPolicy({ root: repoRoot, decisionPolicyPath: undefined });
    const esoMode = policy?.eso?.mode ?? 'observe';

    const turns = new Map();
    let unassigned = 0;

    for (const r of records) {
        let id = r.generationId || r.conversationId || '';
        if (!id) {
            // Pre-`generation_id` records cannot be attributed to a turn without
            // guessing, so they land in one explicit legacy bucket rather than
            // being smeared across real turns.
            unassigned += 1;
            id = '__legacy__';
        }
        if (!turns.has(id)) turns.set(id, newTurn(id));
        const t = turns.get(id);
        t.events += 1;
        t.harnesses.add(r._harness);

        const at = r.at || '';
        if (at) {
            if (!t.startedAt || at < t.startedAt) t.startedAt = at;
            if (!t.endedAt || at > t.endedAt) t.endedAt = at;
        }
        if (r.prompt) t.prompt = r.prompt;
        if (r.model) t.model = String(r.model);
        if (r.subagentType) t.model = `${t.model || 'agent'} → ${r.subagentType}`;

        const p = r.payload || {};
        if (p.composer_mode) t.composerMode = String(p.composer_mode);

        const dtype = r.decisionEventType;
        const dtypes = Array.isArray(r.decisionEventTypes) ? r.decisionEventTypes : dtype ? [dtype] : [];
        for (const d of dtypes) {
            if (d && !t.decisionEvents.includes(d)) t.decisionEvents.push(d);
        }

        // Attached rules are ground truth only on `beforeSubmitPrompt`.
        const attached = Array.isArray(r.ruleFiles) ? r.ruleFiles : [];
        if (attached.length) {
            t.attachedRulePaths = [...new Set([...t.attachedRulePaths, ...attached])];
            for (const fp of attached) t.attachedRules.add(ruleStem(fp));
        }

        const rel = toRel(r.path, repoRoot);
        if (rel) {
            const skill = skillOf(rel);
            if (skill) t.skills.add(skill);
            if (r.event === 'beforeReadFile') t.readEvents.add(rel);
            if (!t.firstEvent.has(rel)) t.firstEvent.set(rel, r.event || 'unknown');
        }

        if (r.event === 'afterFileEdit' && rel) {
            const n = Number(r.editsCount || 1);
            const prev = t.edits.find((e) => e.path === rel);
            if (prev) {
                prev.count += n;
                prev.at = at || prev.at;
            } else {
                t.edits.push({ path: rel, count: n, at });
            }
            t.editsCount += n;
        }

        if (r.event === 'postToolUse') {
            const tool = r.tool || 'unknown';
            t.tools[tool] = (t.tools[tool] || 0) + 1;
            if (BRAIN_RE.test(tool)) t.brain.push({ tool, at });
            if (rel && READ_RE.test(tool)) t.reads.add(rel);
            const cmd = p.tool_input?.command;
            if (typeof cmd === 'string' && cmd.trim()) {
                t.commands.push({ at, cmd: cmd.trim().slice(0, 240) });
            }
        }

        const ctx = r.contextPercent ?? p.context_usage_percent;
        if (ctx != null) {
            t.context = {
                at,
                percent: ctx,
                tokens: r.contextTokens ?? p.context_tokens ?? null,
                window: r.contextWindow ?? p.context_window_size ?? null,
            };
        }

        if (t.steps.length < MAX_STEPS) t.steps.push(stepOf(r, repoRoot));
    }

    const decisionMap = decisionsByGeneration instanceof Map
        ? decisionsByGeneration
        : decisionsByGeneration && typeof decisionsByGeneration === 'object'
          ? new Map(Object.entries(decisionsByGeneration))
          : null;

    const evidenceMap = evidenceByGeneration instanceof Map
        ? evidenceByGeneration
        : evidenceByGeneration && typeof evidenceByGeneration === 'object'
          ? new Map(Object.entries(evidenceByGeneration))
          : null;

    const out = [];
    for (const t of turns.values()) {
        const isLegacy = t.id === '__legacy__';
        // The trace is append-ordered, but the file can be rewritten (a migration,
        // a restore), so order by the recorded timestamp; ties keep append order.
        t.steps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const ledgerDecision = decisionMap && !isLegacy ? decisionMap.get(t.id) : null;
        const evidenceRow = evidenceMap && !isLegacy ? evidenceMap.get(t.id) : null;
        const routeHint = buildAgentHint(ledgerDecision, [...t.attachedRules]);
        const evidenceHint = buildEvidenceHint(evidenceRow?.bundle ?? null, esoMode);
        const agentHint = mergeAgentHints(routeHint, evidenceHint);
        out.push({
            id: t.id,
            legacy: isLegacy,
            harnesses: [...t.harnesses].sort(),
            prompt: t.prompt,
            model: t.model,
            composerMode: t.composerMode,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            events: t.events,
            steps: t.steps.slice(-MAX_STEPS),
            attachedRules: [...t.attachedRules].sort(),
            attachedRulePaths: t.attachedRulePaths.slice(0, MAX_LIST),
            skills: [...t.skills].sort(),
            reads: [...t.reads].sort().slice(0, MAX_LIST),
            readsCount: t.reads.size,
            edits: t.edits.slice(0, MAX_LIST),
            editsCount: t.editsCount,
            tools: t.tools,
            brain: t.brain,
            commands: t.commands.slice(-MAX_LIST),
            context: t.context,
            decisionEvents: t.decisionEvents.slice(),
            decision: ledgerDecision,
            evidence: evidenceRow,
            agentHint,
            checks: isLegacy ? [] : check(t, ruleIndex),
        });
    }

    // Newest first; the legacy bucket always sinks to the bottom.
    out.sort((a, b) => {
        if (a.legacy !== b.legacy) return a.legacy ? 1 : -1;
        return String(b.endedAt || '').localeCompare(String(a.endedAt || ''));
    });

    const kept = out.slice(0, MAX_TURNS);
    const allChecks = kept.flatMap((t) => t.checks);
    return {
        generatedAt: new Date().toISOString(),
        root: repoRoot,
        port,
        revision: null, // filled by the server
        sources,
        parseErrors: bad,
        unassignedEvents: unassigned,
        ruleIndex: { present: ruleIndex.present, generatedAt: ruleIndex.generatedAt },
        totals: {
            turns: out.length,
            shown: kept.length,
            events: records.length,
            edits: kept.reduce((a, t) => a + t.editsCount, 0),
            brain: kept.reduce((a, t) => a + t.brain.length, 0),
            skillsUsed: new Set(kept.flatMap((t) => t.skills)).size,
            checks: allChecks.length,
            failed: allChecks.filter((c) => !c.ok).length,
        },
        turns: kept,
    };
}

/**
 * Per-turn conformance. Each check answers a question the pipeline gate asks,
 * so a FAIL is a concrete deviation, not a vibe. Glob-based checks are marked
 * `heuristic` because the harness picks its own attachments; the rest are exact.
 */
function check(t, ruleIndex) {
    const checks = [];

    checks.push({
        id: 'rules-attached',
        ok: t.attachedRules.size > 0,
        detail: t.attachedRules.size
            ? `${t.attachedRules.size} rule(s): ${[...t.attachedRules].join(', ')}`
            : 'no rule was attached to this request',
    });

    if (t.edits.length) {
        // Files edited that no attached rule's glob covers = the request walked
        // outside its declared route.
        const uncovered = [];
        for (const e of t.edits) {
            if (!ruleIndex.present) break; // no static map -> cannot judge
            let covered = false;
            for (const stem of t.attachedRules) {
                const rule = ruleIndex.rules.get(stem);
                if (!rule) continue;
                if (rule.alwaysApply || rule.re.some((re) => re.test(e.path))) {
                    covered = true;
                    break;
                }
            }
            if (!covered) uncovered.push(e.path);
        }
        checks.push({
            id: 'edits-covered-by-attached-rules',
            heuristic: true,
            ok: uncovered.length === 0,
            detail: !ruleIndex.present
                ? 'route-graph.json missing — run build-route-map.mjs'
                : uncovered.length
                  ? `edited outside the attached route: ${uncovered.join(', ')}`
                  : 'every edited file is covered by an attached rule',
        });

        const protectedEdits = t.edits.filter((e) => PROTECTED.some((re) => re.test(e.path)));
        if (protectedEdits.length) {
            const first = protectedEdits[0].at || '';
            const brain = t.brain.find((b) => !first || !b.at || b.at <= first);
            checks.push({
                id: 'brain-before-protected-write',
                ok: !!brain,
                detail: brain
                    ? `${brain.tool} at ${brain.at} preceded the first protected write`
                    : `protected write(s) with no prior brain call: ${protectedEdits.map((e) => e.path).join(', ')}`,
            });
        }

        const readSet = t.reads;
        // A file is "authored" when it did not exist before this turn: either the
        // harness never read any content for it, or the very first thing recorded
        // for it was an edit. Editing such a file cannot violate read-before-edit.
        // NOTE: src/lib/checks.mjs applies this same invariant to the DB rows. The
        // two copies must not drift again — they did, and the DB copy shipped the
        // OPPOSITE rule ("a read after an edit"), producing 20/20 false positives.
        // src/lib/checks.test.mjs pins the semantics.
        const authored = (p) => !t.readEvents.has(p) || t.firstEvent.get(p) === 'afterFileEdit';
        // Shell-based inspection (`cat file`) is a read too; matching is by path
        // substring, so this check stays approximate and is marked heuristic.
        const shellRead = (p) => t.commands.some((c) => c.cmd.includes(p) || c.cmd.includes(path.basename(p)));
        const unread = t.edits
            .filter((e) => !authored(e.path) && !readSet.has(e.path) && !shellRead(e.path))
            .map((e) => e.path);
        checks.push({
            id: 'read-before-edit',
            heuristic: true,
            ok: unread.length === 0,
            detail: unread.length
                ? `modified an existing file without reading it (Read tool or shell): ${unread.join(', ')}`
                : 'every modified file was read first; newly created files are exempt',
        });

        const lastEdit = t.edits.reduce((a, e) => (String(e.at) > String(a) ? e.at : a), '');
        const verify = t.commands.find((c) => VERIFY_RE.test(c.cmd) && (!lastEdit || !c.at || c.at >= lastEdit));
        // NOTE: src/lib/checks.mjs applies the same rule to the DB rows, but only
        // ever reads the command out of a Shell payload — matching raw JSON let a
        // Read of `.../verify-app.mjs` count as a verify (6/11 false passes).
        checks.push({
            id: 'verify-after-edit',
            ok: !!verify,
            detail: verify ? `verify ran after the last edit: ${verify.cmd.split('\n')[0]}` : 'no build/test command ran after the last edit',
        });
    }

    return checks;
}
