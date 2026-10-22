/**
 * Ingest DeepSeek Harness sessions (`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`).
 *
 * Why this exists: the REQUEST spine was built from Cursor/Antigravity/Claude transcripts. A DSH
 * session produces none of those files, so a consumer that only uses DSH had **zero** rows in the
 * Observatory even while the plugin was gating its tools — the dashboard was blind to the host that
 * actually ran the work.
 *
 * The mapping is the same shape the other spines produce: one conversation per session file, one
 * request per turn, one llm_call per step, and one event per tool call/result. Ids are derived, so
 * re-reading a session updates rows instead of duplicating them.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

import { isoNow } from '@mu/harness-foundation/pure';

/**
 * Read a session file, transparently decompressing the `.zstd` form.
 *
 * The CLI comes first on purpose: a DSH session log is an **append-only series of zstd frames**, one per
 * write, and `zlib.zstdDecompressSync` returns only the first frame — which is the `session` header, so
 * every session looked empty (27 files, 27 conversations, zero turns). `zstd -dc` decodes every frame.
 * The zlib path stays as a fallback for a runtime without the binary, and it is a fallback, not a
 * preference.
 */
export function readSessionText(file) {
    if (!file.endsWith('.zstd')) return fs.readFileSync(file, 'utf8');
    try {
        return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    } catch (err) {
        if (typeof zlib.zstdDecompressSync !== 'function') throw err;
        return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
    }
}

/** Stable 31-bit hash, for events the session writer did not number. */
function lineKey(raw) {
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 1) % 2_000_000_000;
}

function isoOf(ms) {
    return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
}

/**
 * Every session file under the configured dirs, newest last.
 *
 * `projectSlug` filters to one workspace (`--Users-me-Workspaces-repo--`): the DSH home holds the
 * sessions of every workspace on the machine, and a database belongs to one consumer. Without the
 * filter, atrievefin's Observatory showed harness-eso's sessions.
 */
export function discoverDshSessions(dirs = [], options = {}) {
    const wanted = options.projectSlug || null;
    const files = [];
    for (const dir of dirs) {
        let projects;
        try {
            projects = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            if (wanted && project.name !== wanted) continue;
            const projectDir = path.join(dir, project.name);
            let sessions;
            try {
                sessions = fs.readdirSync(projectDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const session of sessions) {
                if (!session.isDirectory()) continue;
                const sessionDir = path.join(projectDir, session.name);
                for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
                    const file = path.join(sessionDir, name);
                    if (fs.existsSync(file)) {
                        files.push({ file, dir: sessionDir, sessionId: session.name, projectSlug: project.name });
                        break;
                    }
                }
            }
        }
    }
    return files.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * @param {object} db
 * @param {{ project: { id: string } }} cfg
 * @param {{ file: string, sessionId: string, projectSlug: string }} found
 */
export function ingestDshSession(db, cfg, found) {
    const text = readSessionText(found.file);
    const events = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            /* a torn last line is normal while the host is writing */
        }
    }

    const header = events.find((e) => e.type === 'session')?.data ?? {};
    const sessionId = header.id || found.sessionId;
    const projectId = cfg.project.id;
    const now = isoNow();

    const model = events.find((e) => e.type === 'request/header')?.data?.header?.config?.model ?? null;
    const times = events.map((e) => Number(e.time)).filter(Number.isFinite);
    const startedAt = times.length ? isoOf(Math.min(...times)) : null;
    const endedAt = times.length ? isoOf(Math.max(...times)) : null;

    const turns = [];
    let current = null;
    let currentStep = null;

    const eventRows = [];
    const pushEvent = (type, e, extra = {}) => {
        eventRows.push({
            event_type: type,
            tool: extra.tool ?? null,
            path: extra.path ?? null,
            request_id: extra.requestId ?? null,
            hook_at: isoOf(e.time),
            /*
             * `seq` when the writer numbered the event, otherwise a stable hash of the line. An index
             * into the parse pass is not stable: a line appearing earlier shifts every later row and the
             * same event is inserted again under a different `source_line_no`.
             */
            source_line_no: Number.isFinite(Number(e.seq)) ? Number(e.seq) + 1 : lineKey(JSON.stringify(e)),
            raw_json: JSON.stringify(e),
        });
    };

    for (const e of events) {
        const data = e.data ?? {};
        if (e.type === 'turn/start') {
            current = {
                turn: Number(data.turn) || turns.length + 1,
                startedAt: isoOf(e.time),
                endedAt: null,
                status: 'completed',
                userTexts: [],
                steps: [],
                tools: 0,
                textChars: 0,
            };
            turns.push(current);
            continue;
        }
        if (!current) continue;

        if (e.type === 'user/message') {
            const textValue = textOf(data.content);
            if (textValue) current.userTexts.push(textValue);
            continue;
        }
        if (e.type === 'step/start') {
            currentStep = {
                step: Number(data.step) || current.steps.length + 1,
                seq: Number.isFinite(Number(e.seq)) ? Number(e.seq) + 1 : current.steps.length + 1,
                texts: [],
                tools: [],
            };
            continue;
        }
        if (e.type === 'assistant/message') {
            const textValue = textOf(data.message?.content ?? data.content);
            if (textValue) {
                if (currentStep) currentStep.texts.push(textValue);
                current.textChars += textValue.length;
            }
            continue;
        }
        if (e.type === 'tool/call') {
            const tool = data.name || data.tool || 'unknown';
            const args = data.arguments || data.input || {};
            if (currentStep) currentStep.tools.push(tool);
            current.tools += 1;
            pushEvent('tool/call', e, { tool, path: args.path ?? args.file_path ?? null, requestId: `${sessionId}:${current.turn}` });
            continue;
        }
        if (e.type === 'tool/result') {
            pushEvent('tool/result', e, {
                tool: data.name || data.tool || null,
                requestId: `${sessionId}:${current.turn}`,
            });
            continue;
        }
        if (e.type === 'step/end') {
            if (currentStep) {
                current.steps.push(currentStep);
                currentStep = null;
            }
            continue;
        }
        if (e.type === 'turn/end') {
            current.endedAt = isoOf(e.time);
            current.status = data.reason?.kind === 'error' ? 'error' : 'completed';
            if (currentStep) {
                current.steps.push(currentStep);
                currentStep = null;
            }
            pushEvent('turn/end', e, { requestId: `${sessionId}:${current.turn}` });
            const status = current.status;
            void status;
            current = null;
        }
    }

    db.run(
        `INSERT INTO conversation (id, project_id, transcript_path, byte_size, line_count, started_at, ended_at, request_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            transcript_path = excluded.transcript_path,
            byte_size = excluded.byte_size,
            line_count = excluded.line_count,
            started_at = COALESCE(conversation.started_at, excluded.started_at),
            ended_at = excluded.ended_at,
            request_count = excluded.request_count,
            updated_at = excluded.updated_at`,
        [
            sessionId,
            projectId,
            found.file,
            fs.statSync(found.file).size,
            events.length,
            startedAt,
            endedAt,
            turns.length,
            now,
            now,
        ],
    );

    for (const turn of turns) {
        const requestId = `${sessionId}:${turn.turn}`;
        const userQuery = turn.userTexts.join('\n').trim() || '(no user message recorded)';
        const toolCount = turn.steps.reduce((n, step) => n + step.tools.length, 0) || turn.tools;
        db.run(
            `INSERT INTO request
                (id, project_id, conversation_id, boundary_index, generation_id, user_query, prompt_at,
                 started_at, ended_at, status, call_count, tool_count, text_chars, model_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                user_query = excluded.user_query,
                prompt_at = excluded.prompt_at,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                status = excluded.status,
                call_count = excluded.call_count,
                tool_count = excluded.tool_count,
                text_chars = excluded.text_chars,
                model_id = COALESCE(excluded.model_id, request.model_id),
                updated_at = excluded.updated_at`,
            [
                requestId,
                projectId,
                sessionId,
                turn.turn,
                null,
                userQuery,
                turn.startedAt,
                turn.startedAt,
                turn.endedAt,
                turn.status,
                turn.steps.length,
                toolCount,
                turn.textChars,
                model,
                now,
                now,
            ],
        );

        for (const step of turn.steps) {
            const preview = step.texts.join('\n').slice(0, 400);
            db.run(
                `INSERT INTO llm_call
                    (id, project_id, request_id, call_index, file_line_no, tool_count, text_chars, tool_names, preview, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    tool_count = excluded.tool_count,
                    text_chars = excluded.text_chars,
                    tool_names = excluded.tool_names,
                    preview = excluded.preview`,
                [
                    `${requestId}:step${step.step}`,
                    projectId,
                    requestId,
                    step.step,
                    step.seq,
                    step.tools.length,
                    step.texts.join('\n').length,
                    [...new Set(step.tools)].join(','),
                    preview,
                    now,
                ],
            );
        }
    }

    for (const row of eventRows) {
        db.run(
            `INSERT OR IGNORE INTO event
                (project_id, harness, event_type, tool, path, generation_id, conversation_id, request_id, hook_at, source_path, source_line_no, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                projectId,
                'dsh',
                row.event_type,
                row.tool,
                row.path,
                null,
                sessionId,
                row.request_id,
                row.hook_at,
                found.file,
                row.source_line_no,
                row.raw_json,
            ],
        );
    }

    return {
        ok: true,
        file: found.file,
        sessionId,
        turns: turns.length,
        requests: turns.length,
        calls: turns.reduce((n, turn) => n + turn.steps.length, 0),
        events: eventRows.length,
    };
}

/** Ingest every discovered session under the configured directories. */
export function ingestDshSessions(db, cfg, dirs = cfg.ingest?.dshSessionDirs ?? []) {
    const reports = [];
    for (const found of discoverDshSessions(dirs, { projectSlug: cfg.ingest?.dshProjectSlug })) {
        try {
            reports.push(ingestDshSession(db, cfg, found));
        } catch (err) {
            reports.push({ ok: false, file: found.file, reason: err.message });
        }
    }
    return reports;
}
