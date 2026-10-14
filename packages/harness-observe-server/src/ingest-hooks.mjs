/**
 * Hook ingest — routing EVIDENCE.
 *
 * Two hook trees write in parallel for the same project (`.cursor/…` and
 * `.agents/…`), so every row carries a `harness` column and is keyed by its
 * source line, which makes repeated passes free.
 *
 * Hooks cannot see where one LLM call ends (loop_count is always 0, and the
 * tool_use ids do not exist on the transcript side), so nothing here touches
 * llm_call. What hooks own: attached rules, tool/file evidence, and the token
 * totals on the `stop` event.
 *
 * Overlay runs in two steps because the two sources arrive independently:
 * link generation_id -> request, then attribute the raw events to that request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isoNow } from './observe-config.mjs';
import {
    backfillAntigravityGenerationIds,
    hasRealGenerationLink,
    linkEventsByGenerationOrRequestId,
    rollRequestToolsFromLlmCalls,
} from './ag-request-enrich.mjs';
import { shellCommandOf, shellHasWriteIntent, shellWriteTargets } from '@mu/harness-foundation/pure';

const FILE_PATH_KEYS = ['file_path', 'path', 'target_file', 'notebook_path', 'absolute_path'];

function harnessOf(filePath) {
    const p = filePath.replace(/\\/g, '/');
    if (p.includes('/.agents/')) return 'agents';
    return 'cursor';
}

function getState(db, projectId, sourcePath) {
    return (
        db.get(
            'SELECT * FROM ingest_state WHERE project_id = ? AND source_kind = ? AND source_path = ?',
            [projectId, 'hooks', sourcePath],
        ) || { last_size: 0, last_offset: 0, last_line_no: 0 }
    );
}

function putState(db, projectId, sourcePath, size, offset, lineNo, error) {
    db.run(
        `INSERT INTO ingest_state (project_id, source_kind, source_path, last_size, last_offset, last_line_no, last_error, updated_at)
         VALUES (?, 'hooks', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source_kind, source_path) DO UPDATE SET
             last_size = excluded.last_size, last_offset = excluded.last_offset,
             last_line_no = excluded.last_line_no, last_error = excluded.last_error, updated_at = excluded.updated_at`,
        [projectId, sourcePath, size, offset, lineNo, error || null, isoNow()],
    );
}

function extractPath(rec) {
    if (rec.path) return rec.path;
    const input = (rec.payload && rec.payload.tool_input) || rec.tool_input;
    if (input && typeof input === 'object') {
        for (const k of FILE_PATH_KEYS) {
            if (typeof input[k] === 'string' && input[k]) return input[k];
        }
    }
    return '';
}

function actionOf(tool) {
    const t = (tool || '').replace(/^MCP:/, '');
    if (/^(Read|read|Grep|Glob|List)/.test(t)) return 'read';
    if (/(Write|StrReplace|Edit|MultiEdit|Delete|NotebookEdit)/.test(t)) return 'edit';
    if (/(Shell|Bash|Terminal)/.test(t)) return 'shell';
    return 'other';
}

/** Tail one hook file into the `event` table. */
export function ingestHookFile(db, cfg, hookPath) {
    const projectId = cfg.project.id;
    if (!fs.existsSync(hookPath)) return { path: hookPath, ok: true, skipped: true, newEvents: 0 };

    const harness = harnessOf(hookPath);
    const isRouteTrace = /route-trace\.jsonl$/i.test(hookPath.replace(/\\/g, '/'));
    const now = isoNow();
    let state = getState(db, projectId, hookPath);
    const buf = fs.readFileSync(hookPath);
    const size = buf.length;
    let rebuilt = false;
    if (size < state.last_offset) {
        db.run('DELETE FROM event WHERE project_id = ? AND harness = ? AND source_path = ?', [projectId, harness, hookPath]);
        state = { last_size: 0, last_offset: 0, last_line_no: 0 };
        rebuilt = true;
    }

    const text = buf.subarray(state.last_offset).toString('utf8');
    const parts = text.split('\n');
    const completeCount = text.endsWith('\n') ? parts.length - 1 : Math.max(0, parts.length - 1);
    const report = { path: hookPath, harness, ok: true, rebuilt, newEvents: 0, newPrompts: 0, newStops: 0 };
    if (completeCount === 0) {
        report.touchedGenerations = [];
        return report;
    }
    const touched = new Set();

    db.tx(() => {
        let offset = state.last_offset;
        let lineNo = state.last_line_no;
        for (let i = 0; i < completeCount; i += 1) {
            const line = parts[i];
            offset += Buffer.byteLength(line, 'utf8') + 1;
            lineNo += 1;
            if (!line.trim()) continue;
            let rec;
            try {
                rec = JSON.parse(line);
            } catch {
                continue;
            }
            const payload = rec.payload || {};
            let eventType = rec.event || payload.hook_event_name || 'unknown';
            if (isRouteTrace && eventType === 'unknown') eventType = 'route_trace';
            const generationId = rec.generationId || payload.generation_id || null;
            const conversationId = rec.conversationId || payload.conversation_id || null;
            const tool = rec.tool || payload.tool_name || null;
            const filePath = extractPath({ ...payload, path: rec.path }) || null;
            const decisionEventType =
                rec.decisionEventType ||
                (Array.isArray(rec.decisionEventTypes) ? rec.decisionEventTypes[0] : null) ||
                null;
            if (generationId) touched.add(generationId);

            db.run(
                `INSERT INTO event (project_id, harness, event_type, tool, path, generation_id, conversation_id,
                    hook_at, source_path, source_line_no, decision_event_type, raw_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(project_id, harness, source_path, source_line_no) DO NOTHING`,
                [
                    projectId,
                    harness,
                    eventType,
                    tool,
                    filePath,
                    generationId,
                    conversationId,
                    rec.at || null,
                    hookPath,
                    lineNo,
                    decisionEventType,
                    line,
                ],
            );
            report.newEvents += 1;

            const genForPrompt = generationId || (eventType === 'preInvocation' ? conversationId : null);
            if ((eventType === 'beforeSubmitPrompt' || eventType === 'preInvocation') && genForPrompt) {
                // Rules ride on the ENVELOPE (`rec.attachments`), as
                // `{ type: 'rule', file_path: '…' }` — not on the payload, and the
                // key is `file_path`, not `path`. Reading the wrong key turned
                // every rule list into `[]`, which silently disabled the
                // route-conformance checks that depend on knowing which rules were
                // attached to the request.
                const rules = (payload.attachments || rec.attachments || [])
                    .filter((a) => a && (a.type === 'rule' || a.kind === 'rule'))
                    .map((a) => a.file_path || a.path || a.file || a.id || '')
                    .filter(Boolean);
                db.run(
                    `INSERT INTO hook_prompt (project_id, generation_id, conversation_id, prompt_text, rules_json, hook_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(project_id, generation_id) DO UPDATE SET
                         conversation_id = COALESCE(excluded.conversation_id, hook_prompt.conversation_id),
                         prompt_text = COALESCE(excluded.prompt_text, hook_prompt.prompt_text),
                         rules_json = COALESCE(excluded.rules_json, hook_prompt.rules_json)`,
                    [
                        projectId,
                        genForPrompt,
                        conversationId,
                        (rec.prompt || payload.prompt || '') || null,
                        JSON.stringify(rules),
                        rec.at || null,
                    ],
                );
                report.newPrompts += 1;
            }

            if (eventType === 'stop') {
                const usage = payload.tokenUsage || payload.usage || payload.metrics || {};
                const inputTok =
                    numOrNull(payload.input_tokens) ??
                    numOrNull(payload.inputTokens) ??
                    numOrNull(usage.inputTokens) ??
                    numOrNull(usage.promptTokenCount);
                const outputTok =
                    numOrNull(payload.output_tokens) ??
                    numOrNull(payload.outputTokens) ??
                    numOrNull(usage.outputTokens) ??
                    numOrNull(usage.candidatesTokenCount);
                const gen = generationId || conversationId;
                if (gen) {
                    db.run(
                        `INSERT INTO request_stop (project_id, generation_id, harness, model_id, status, input_tokens,
                            output_tokens, cache_read, cache_write, conversation_id, hook_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(project_id, generation_id, harness) DO UPDATE SET
                             model_id = excluded.model_id, status = excluded.status,
                             input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
                             cache_read = excluded.cache_read, cache_write = excluded.cache_write,
                             conversation_id = COALESCE(excluded.conversation_id, request_stop.conversation_id),
                             hook_at = excluded.hook_at`,
                        [
                            projectId,
                            gen,
                            harness,
                            payload.model_id || payload.modelId || null,
                            payload.status || null,
                            inputTok,
                            outputTok,
                            numOrNull(payload.cache_read_tokens) ?? numOrNull(usage.cachedContentTokenCount),
                            numOrNull(payload.cache_write_tokens),
                            conversationId,
                            rec.at || null,
                        ],
                    );
                    report.newStops += 1;
                }
            }
        }
        putState(db, projectId, hookPath, size, offset, lineNo, null);
    });

    report.touchedGenerations = [...touched];
    return report;
}

function numOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Overlay hooks onto the transcript spine.
 *
 * Join order, strongest first:
 *   1. exact prompt text within the same conversation (the transcript's
 *      <user_query> is the same string the hook saw on beforeSubmitPrompt)
 *   2. left-over prompts paired by order — the two sources are both append-only
 *      per conversation, so their nth prompt is normally the same prompt
 * Anything still unmatched is left with a NULL generation_id rather than being
 * guessed onto a request: a wrong link is worse than a missing one, because the
 * whole point of this tool is judging whether routing was correct.
 */
export function linkRequests(db, cfg) {
    const projectId = cfg.project.id;
    const now = isoNow();

    /*
     * The placeholder stamp deliberately does NOT run here. It writes to the same column the link
     * guard below reads, so running it first made every match impossible: `if (hit.generation_id)
     * continue` saw the placeholder on every turn and skipped every prompt. `request_rule` was empty
     * for the whole project as a result. It now runs at the end, once real matching has been tried.
     */

    // Self-heal: one generation can belong to exactly ONE request. Anything else
    // is damage from a cross-conversation mis-link (the prompt list was fetched
    // project-wide while the "already used" set was reset per conversation, so a
    // prompt like "continue" got attached to a request in EVERY conversation and
    // one request's token total was then counted in a dozen different days).
    // Clear the provably-wrong links and rebuild them below.
    const dupIds = db
        .all(
            `SELECT generation_id FROM request
             WHERE project_id = ? AND generation_id IS NOT NULL
             GROUP BY generation_id HAVING COUNT(*) > 1`,
            [projectId],
        )
        .map((r) => r.generation_id);
    let repaired = 0;
    if (dupIds.length) {
        // Materialise the id list FIRST. `UPDATE … WHERE generation_id IN (SELECT …
        // FROM request …)` re-evaluates that subquery against the table as rows are
        // nulled, so it stops matching part-way through and silently leaves the
        // rest of the duplicates in place. The token columns are cleared too,
        // because tokens that were credited from a wrong link are not evidence.
        const ph = dupIds.map(() => '?').join(',');
        const info = db.run(
            `UPDATE request SET generation_id = NULL,
                input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL,
                cache_write_tokens = NULL, stop_status = NULL
             WHERE project_id = ? AND generation_id IN (${ph})`,
            [projectId, ...dupIds],
        );
        repaired = info ? Number(info.changes || 0) : 0;
    }

    // Prompts are a PROJECT-wide list. Each one is matched to a request inside its
    // own conversation, and the match is TIME-FIRST: the hook fires at the instant
    // the user submitted, so a prompt belongs to the last request in that
    // conversation that had already started when it fired. Matching on text alone
    // is what put a "continue" prompt on the *earliest* "continue" turn of the
    // conversation (and therefore 10.7M input tokens on the wrong date) instead of
    // the turn it actually opened.
    const prompts = db.all(
        'SELECT generation_id, prompt_text, rules_json, conversation_id, hook_at FROM hook_prompt WHERE project_id = ? ORDER BY hook_at',
        [projectId],
    );

    // A generation belongs to one request for good. Seeding the used-set from the
    // surviving links stops the loop from re-attaching an already-correct prompt.
    // Only REAL links count: the placeholder (generation_id === id) means "not linked", and treating
    // it as a survivor would both block the loop and claim a match that never happened.
    const used = new Set(
        db
            .all('SELECT id, generation_id FROM request WHERE project_id = ? AND generation_id IS NOT NULL', [
                projectId,
            ])
            .filter((r) => hasRealGenerationLink(r))
            .map((r) => r.generation_id),
    );

    let linked = 0;
    for (const p of prompts) {
        if (used.has(p.generation_id) || !p.conversation_id) continue;
        const pool = db.all(
            `SELECT id, generation_id, started_at, user_query FROM request
             WHERE project_id = ? AND conversation_id = ? AND started_at IS NOT NULL
             ORDER BY started_at`,
            [projectId, p.conversation_id],
        );
        if (!pool.length) continue;

        let hit = null;
        if (p.hook_at) {
            const t = p.hook_at.replace(/Z$/, '');
            for (const r of pool) {
                if (r.started_at <= t) hit = r;
                else break;
            }
        }
        // No usable clock for this prompt — a unique text match is the only signal
        // left, and an ambiguous one is refused rather than guessed.
        if (!hit && p.prompt_text) {
            const matches = pool.filter((r) => !hasRealGenerationLink(r) && norm(r.user_query) === norm(p.prompt_text));
            if (matches.length === 1) hit = matches[0];
        }
        if (!hit) continue;
        // That turn is already accounted for: two prompts inside one request window
        // is a duplicate submission and a request can only name one generation.
        // `hasRealGenerationLink` distinguishes a genuine earlier link from the placeholder this
        // module writes, which must NOT count as "already accounted for".
        if (hasRealGenerationLink(hit)) continue;
        // A time hit whose text disagrees is not a link — it is two different turns.
        if (p.prompt_text && norm(hit.user_query) !== norm(p.prompt_text)) continue;

        used.add(p.generation_id);
        applyLink(db, projectId, hit.id, p, now);
        linked += 1;
    }

    linkEventsByGenerationOrRequestId(db, projectId);
    /*
     * The event's OWN `generation_id` is first-hand evidence, and it is authoritative.
     *
     * This used to be a fill (`request_id IS NULL`), which meant a wrong guess was permanent. The guess
     * that produced the wrong values is the turn-window fallback below: hooks are written by the IDE as
     * calls happen, while requests come from the transcript on a 15s poll, so a tool event routinely
     * arrives **before** the turn it belongs to exists as a row. The window fallback then attached it to
     * the previous request in the conversation, and when the transcript caught up and the prompt was
     * linked, nothing revisited the event — so it stayed on the wrong turn forever.
     *
     * Measured on x79: **3,438** events whose `generation_id` conflicted with the generation of the
     * request they were filed under, across 7 conversations. The visible symptom was a turn showing 2 of
     * its 21 tool calls, its file edits attributed to the previous turn, and a conformance check
     * reporting "no protected path was edited" about a turn that had edited `backend/mu-fusion/`.
     *
     * Generation is safe to treat as authoritative because exactly one request can hold it:
     * `linkRequests` enforces that with its `used` set and the duplicate repair above. So this resolves
     * to one row or none, and it may therefore overwrite — a guess must yield to the event's own record.
     *
     * The final `request_id != (...)` guard keeps this from re-writing identical rows, so it is a no-op
     * once converged and does not force a full recompute on every pass.
     */
    const resolved = `(SELECT r.id FROM request r
                       WHERE r.project_id = event.project_id AND r.generation_id = event.generation_id
                       LIMIT 1)`;
    const corrected = db.run(
        `UPDATE event SET request_id = ${resolved}
         WHERE project_id = ? AND generation_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM request r
                       WHERE r.project_id = event.project_id AND r.generation_id = event.generation_id)
           AND (request_id IS NULL OR request_id != ${resolved})`,
        [projectId],
    );

    // Everything else is placed by the turn window it fired in — NOT by dumping it
    // on the conversation's first request, which credited one turn with every
    // tool call and file touch of the whole conversation. A turn starts at its
    // prompt when the hook saw one, and otherwise at the minute the transcript
    // recorded; it ends when the next turn starts. The prompt time wins because
    // transcript timestamps are minute-rounded, coarse enough to straddle two
    // turns at a boundary.
    const WINDOW_START = `COALESCE(replace(hp.hook_at, 'Z', ''), r.started_at)`;
    db.run(
        `UPDATE event SET request_id = (
            SELECT r.id FROM request r
            LEFT JOIN hook_prompt hp ON hp.project_id = r.project_id AND hp.generation_id = r.generation_id
            WHERE r.project_id = event.project_id AND r.conversation_id = event.conversation_id
              AND ${WINDOW_START} IS NOT NULL
              AND ${WINDOW_START} <= replace(event.hook_at, 'Z', '')
            ORDER BY ${WINDOW_START} DESC LIMIT 1)
         WHERE project_id = ? AND request_id IS NULL
           AND conversation_id IS NOT NULL AND hook_at IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM request r
               LEFT JOIN hook_prompt hp ON hp.project_id = r.project_id AND hp.generation_id = r.generation_id
               WHERE r.project_id = event.project_id AND r.conversation_id = event.conversation_id
                 AND ${WINDOW_START} IS NOT NULL
                 AND ${WINDOW_START} <= replace(event.hook_at, 'Z', ''))`,
        [projectId],
    );

    // Attribute a stop to its request. Step 1 is the strong link: the stop names
    // the same generation as the prompt, so there is nothing to guess.
    db.run(
        `UPDATE request_stop SET request_id = (
            SELECT r.id FROM request r
            WHERE r.project_id = request_stop.project_id AND r.generation_id = request_stop.generation_id
            LIMIT 1)
         WHERE project_id = ? AND request_id IS NULL AND generation_id IS NOT NULL`,
        [projectId],
    );

    // Step 2 is the fallback for turns whose `beforeSubmitPrompt` was never
    // captured (the prompt hook was installed later than the stop hook), which
    // left their token totals stranded with no generation to join on.
    //
    // A stop is written when a turn FINISHES, so the turn it belongs to is the
    // last request in that conversation that had already started when the stop
    // fired. `started_at` and `hook_at` are both UTC ISO ('…T18:46:02'), so the
    // trailing 'Z' is stripped and the plain string compare orders correctly.
    // Note this assigns tokens only — never `request.generation_id`, which must
    // stay the identity of the prompt.
    db.run(
        `UPDATE request_stop SET request_id = (
            SELECT r.id FROM request r
            LEFT JOIN hook_prompt hp ON hp.project_id = r.project_id AND hp.generation_id = r.generation_id
            WHERE r.project_id = request_stop.project_id
              AND r.conversation_id = request_stop.conversation_id
              AND ${WINDOW_START} IS NOT NULL
              AND ${WINDOW_START} <= replace(request_stop.hook_at, 'Z', '')
            ORDER BY ${WINDOW_START} DESC LIMIT 1)
         WHERE project_id = ? AND request_id IS NULL AND hook_at IS NOT NULL AND conversation_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM request r
               LEFT JOIN hook_prompt hp ON hp.project_id = r.project_id AND hp.generation_id = r.generation_id
               WHERE r.project_id = request_stop.project_id
                 AND r.conversation_id = request_stop.conversation_id
                 AND ${WINDOW_START} IS NOT NULL
                 AND ${WINDOW_START} <= replace(request_stop.hook_at, 'Z', ''))`,
        [projectId],
    );

    /*
     * Only now stamp the placeholder on turns that still have no real link. Placed last because it
     * writes the column the guards above read: running it first is what silently disabled every
     * prompt match and left `request_rule` empty for the whole project.
     */
    backfillAntigravityGenerationIds(db, projectId);

    /*
     * Corrections count as repairs. `repaired > 0` is what makes the cycle recompute everything instead
     * of only the turns it touched, and re-attributing an event changes that turn's files, tools and
     * conformance verdicts — none of which would be revisited under a narrow scope. Reporting the count
     * is what turns a silent data fix into a visible rebuild.
     */
    const correctedCount = corrected ? Number(corrected.changes || 0) : 0;

    return { linked, repaired: repaired + correctedCount, corrected: correctedCount };
}

function applyLink(db, projectId, requestId, prompt, now) {
    db.run(
        `UPDATE request SET generation_id = ?, updated_at = ? WHERE id = ?`,
        [prompt.generation_id, now, requestId],
    );
    if (prompt.rules_json) {
        try {
            const rules = JSON.parse(prompt.rules_json);
            for (const rule of rules) {
                db.run(
                    `INSERT INTO request_rule (request_id, rule_id, attached_at) VALUES (?, ?, ?)
                     ON CONFLICT(request_id, rule_id) DO NOTHING`,
                    [requestId, rule, prompt.hook_at || null],
                );
            }
        } catch {
            /* malformed rules json is not fatal */
        }
    }
}

/**
 * Roll the raw events up into per-request tool/file rows and pull the stop
 * token totals onto the request. Tokens stay NULL when the stop carried none
 * (status=error stops have no token fields) — never 0, so the UI can show "—".
 */
export function overlayEvidence(db, cfg, scope) {
    const projectId = cfg.project.id;
    const now = isoNow();
    // scope === null means "every request" (first pass, or a rebuild). Otherwise
    // only the requests this cycle touched are re-rolled up — without that, a 2s
    // poll re-aggregated thousands of untouched rows on every tick and the ingest
    // loop could never keep up with its own interval.
    let requests;
    if (!scope) {
        requests = db.all('SELECT id FROM request WHERE project_id = ?', [projectId]);
    } else {
        const ids = [...(scope.requestIds || [])];
        const gens = [...(scope.generations || [])];
        if (!ids.length && !gens.length) return 0;
        const idPh = ids.map(() => '?').join(',') || 'NULL';
        const genPh = gens.map(() => '?').join(',') || 'NULL';
        requests = db.all(
            `SELECT id FROM request WHERE project_id = ? AND (id IN (${idPh}) OR generation_id IN (${genPh}))`,
            [projectId, ...ids, ...gens],
        );
    }

    for (const r of requests) {
        db.run('DELETE FROM request_tool WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM request_file WHERE request_id = ?', [r.id]);

        let tools = db.all(
            `SELECT COALESCE(tool, event_type) AS t, COUNT(*) AS n FROM event
             WHERE request_id = ? AND event_type = 'postToolUse' AND tool IS NOT NULL
             GROUP BY tool`,
            [r.id],
        );
        if (!tools.length) {
            rollRequestToolsFromLlmCalls(db, r.id);
            tools = db.all(
                `SELECT tool AS t, count AS n FROM request_tool WHERE request_id = ? ORDER BY count DESC`,
                [r.id],
            );
        }
        for (const t of tools) {
            db.run(
                `INSERT INTO request_tool (request_id, tool, count) VALUES (?, ?, ?)
                 ON CONFLICT(request_id, tool) DO UPDATE SET count = excluded.count`,
                [r.id, t.t, t.n],
            );
        }

        const files = db.all(
            `SELECT e.path, e.tool, COUNT(*) AS n FROM event e
             WHERE e.request_id = ? AND e.path IS NOT NULL AND e.path != ''
             GROUP BY e.path, e.tool`,
            [r.id],
        );
        const byPath = new Map();
        for (const f of files) {
            const act = actionOf(f.tool);
            const cur = byPath.get(f.path) || { actions: new Set(), reads: 0, edits: 0 };
            cur.actions.add(act);
            if (act === 'read') cur.reads += f.n;
            if (act === 'edit') cur.edits += f.n;
            byPath.set(f.path, cur);
        }

        /*
         * Shell writes. `actionOf` can only see the tool name, and Shell is a different tool from
         * Write/StrReplace — so a `cat > protected/file.md` was recorded as a **read** of that file.
         * Measured on x79: one turn wrote 7 protected files through Shell and every one of them landed
         * in `request_file` with `edits = 0`, which is how the conformance checks came to report
         * "no protected path was edited" while the files sat on disk.
         *
         * The command is the only place the intent exists, so it is read here and the targets are
         * attributed to the request the same way a Write would be.
         */
        const shellEvents = db.all(
            `SELECT path, raw_json FROM event
             WHERE request_id = ? AND tool IN ('Shell', 'Bash', 'Terminal') AND raw_json IS NOT NULL`,
            [r.id],
        );
        const rootPrefix = `${cfg.root}/`;
        for (const ev of shellEvents) {
            const cmd = shellCommandOf(ev.raw_json);
            if (!shellHasWriteIntent(cmd)) continue;
            const parsed = shellWriteTargets(cmd).map((t) =>
                t.startsWith(rootPrefix) ? t.slice(rootPrefix.length) : t,
            );
            // A Python heredoc writes a path held in a variable: no target parses, and the event's own
            // path is the only signal. Use it rather than counting nothing.
            const targets = parsed.length ? parsed : ev.path ? [ev.path] : [];
            for (const t of targets) {
                const cur = byPath.get(t) || { actions: new Set(), reads: 0, edits: 0 };
                cur.actions.add('edit');
                cur.edits += 1;
                byPath.set(t, cur);
            }
        }

        for (const [p, v] of byPath) {
            db.run(
                `INSERT INTO request_file (request_id, path, actions, reads, edits) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(request_id, path) DO UPDATE SET actions = excluded.actions, reads = excluded.reads, edits = excluded.edits`,
                [r.id, p, [...v.actions].join(','), v.reads, v.edits],
            );
        }

        // prefer the cursor tree when both harnesses recorded the same generation
        // Prefer the stop that shares this request's generation (the exact link);
        // fall back to the turn-window attribution. When several stops land on one
        // request the newest wins, because a stop reports its turn's running total
        // — not a per-call delta that would be summed.
        const stop = db.get(
            `SELECT * FROM request_stop WHERE project_id = ?
               AND (generation_id = (SELECT generation_id FROM request WHERE id = ?) OR request_id = ?)
             ORDER BY
               CASE WHEN generation_id = (SELECT generation_id FROM request WHERE id = ?) THEN 0 ELSE 1 END,
               CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END,
               hook_at DESC,
               CASE harness WHEN 'cursor' THEN 0 ELSE 1 END
             LIMIT 1`,
            [projectId, r.id, r.id, r.id],
        );
        if (stop) {
            db.run(
                `UPDATE request SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
                    model_id = COALESCE(?, model_id), stop_status = ?, updated_at = ?
                 WHERE id = ?`,
                [
                    stop.input_tokens,
                    stop.output_tokens,
                    stop.cache_read,
                    stop.cache_write,
                    stop.model_id,
                    stop.status,
                    now,
                    r.id,
                ],
            );
            const conflicting = db.get(
                `SELECT COUNT(DISTINCT COALESCE(status,'')) AS n FROM request_stop
                 WHERE project_id = ? AND generation_id = (SELECT generation_id FROM request WHERE id = ?)`,
                [projectId, r.id],
            );
            if (conflicting && conflicting.n > 1) {
                db.run(
                    `INSERT INTO check_result (request_id, check_id, status, heuristic, detail)
                     VALUES (?, 'source-conflict', 'warn', 1, 'the two harness trees disagreed on this request''s stop status')
                     ON CONFLICT(request_id, check_id) DO UPDATE SET status = 'warn', detail = excluded.detail`,
                    [r.id],
                );
            }
        } else {
            // No stop covers this request. Clear rather than keep whatever a
            // previous, wrongly-attributed pass wrote here: a stale token total is
            // exactly the kind of thing this tool exists to rule out.
            db.run(
                `UPDATE request SET input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL,
                    cache_write_tokens = NULL, stop_status = NULL
                 WHERE id = ? AND input_tokens IS NOT NULL`,
                [r.id],
            );
        }

        // transcript is the ground truth for completion; note a disagreement
        const row = db.get('SELECT status, stop_status FROM request WHERE id = ?', [r.id]);
        if (row && row.stop_status && row.status !== 'in_progress' && row.stop_status !== row.status) {
            db.run(
                `INSERT INTO check_result (request_id, check_id, status, heuristic, detail)
                 VALUES (?, 'status-conflict', 'warn', 1, ?)
                 ON CONFLICT(request_id, check_id) DO UPDATE SET status = 'warn', detail = excluded.detail`,
                [r.id, `transcript says ${row.status}, hook stop says ${row.stop_status}`],
            );
        }
    }
}
