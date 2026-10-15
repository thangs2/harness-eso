/**
 * Transcript ingest — the REQUEST spine.
 *
 * A Cursor transcript is an append-only JSONL conversation file. It is the only
 * source that knows where one LLM call ends and the next begins, so it owns two
 * things and nothing else owns them:
 *
 *   request   = one real user prompt (a user line carrying <timestamp> +
 *               <user_query>). This is the "1 request" the UI lists.
 *   llm_call  = exactly one `assistant` line. This is the "many calls" under it.
 *
 * Everything is derived from line position, never from a running count, so the
 * same file always yields the same rows. Ingest is incremental: it resumes from
 * a byte offset, and only advances that offset in the same transaction as the
 * rows it produced. A truncated or rotated file resets that one conversation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoNow } from './observe-config.mjs';
import { insertPromptRow } from './mcp-prompt-store.mjs';

const UQ_RE = /<user_query>([\s\S]*?)<\/user_query>/;
const TS_RE = /<timestamp>([\s\S]*?)<\/timestamp>/;

/** The transcript only has a human timestamp, so parse it best-effort to ISO. */
/**
 * Transcript prompt timestamps are wall-clock with an explicit zone annotation:
 *   "Monday, Oct 12, 2026, 6:00 PM (UTC+7)"
 *
 * That annotation is the ONLY zone information in the line, and `Date.parse` ignores it
 * in favour of the PROCESS timezone. Ingest runs inside the observe container, where TZ
 * is UTC — so a UTC+7 operator's prompts were recorded 7h in the FUTURE and every
 * window join built on `started_at` (prompt attachments, stop token windows) silently
 * matched nothing.
 *
 * So: parse the wall clock deterministically as UTC, then apply the annotated offset.
 * The result no longer depends on where ingest happens to run.
 */
/**
 * Read `length` bytes at `offset` without loading the rest of the file.
 *
 * Loops because `readSync` may return short on a file being appended to (which is exactly the case
 * here — the agent transcript is live). A short read is not an error, just an incomplete window.
 */
function readRange(filePath, offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
            const n = fs.readSync(fd, buf, read, length - read, offset + read);
            if (n <= 0) break;
            read += n;
        }
        return buf.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

export function parsePromptTs(raw) {
    if (!raw) return null;
    const zone = /\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)/i.exec(String(raw));
    const cleaned = String(raw).replace(/\(UTC[^)]*\)/i, '').trim();
    let ms = Date.parse(`${cleaned} UTC`);
    if (!Number.isFinite(ms)) ms = Date.parse(cleaned);
    if (!Number.isFinite(ms)) return null;
    if (zone) {
        const sign = zone[1] === '-' ? -1 : 1;
        const offsetMinutes = (Number.parseInt(zone[2], 10) || 0) * 60 + (Number.parseInt(zone[3], 10) || 0);
        ms -= sign * offsetMinutes * 60_000;
    }
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Bytes of the file immediately before the cursor, used to prove the cursor still points where we
 * left it.
 */
const SEAM_BYTES = 64;

/** sha256 of the bytes ending at `offset`, or null when there is nothing before it. */
function seamHashOf(filePath, offset) {
    if (offset <= 0) return null;
    const start = Math.max(0, offset - SEAM_BYTES);
    const seam = readRange(filePath, start, offset - start);
    if (!seam.length) return null;
    return crypto.createHash('sha256').update(seam).digest('hex');
}

function userText(msg) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}

/**
 * Shared with `parse-transcript-calls.mjs` so the backfill cannot drift from
 * ingest — do not fork this formula.
 *
 * `emitChars` is EMITTED CHARACTERS, not a provider token count: no layer records
 * per-call usage (assistant lines carry none, and hooks cover 0.8% of turns), so
 * the measured size of what the assistant actually emitted is the honest signal.
 * `textChars` stays a text-only field; the tool_use JSON is ~90% of the bytes.
 */
const BRAIN_FLASH_PREFIX = /^\[brain flash\]/i;
const BRAIN_FALLBACK_PREFIX = /^\[brain fallback\]/i;
const ROUTE_OVERRIDE_PREFIX = /^\[(pro|flash)\]/i;

/**
 * Canonical MCP label for one tool_use block.
 *
 * Cursor routes every MCP call through a single generic tool named `CallDynamicTool`, with the real
 * server and tool in the input (`{namespace, toolName, arguments}`). Storing the wrapper name meant
 * `mcp_call_stats` reported **zero** brain and Pro calls for every Cursor turn — 339 brain calls in one
 * conversation, all counted as `CallDynamicTool`. Reading the input is the whole fix.
 *
 * `ask_deepseek_flash` is one tool serving two very different roles, chosen by a prompt prefix the
 * server itself reads (`flashRole()`): `[BRAIN FLASH]` / `[BRAIN FALLBACK]` means thinking ON (Brain),
 * anything else is the executor. The prefix has to be resolved here, because the tool name alone
 * cannot tell them apart — and the tier is what determines cost. Measured across this machine's
 * transcripts, 248 of 588 `ask_deepseek_flash` calls are Brain, so guessing from the name would be
 * wrong most of the time in the other direction.
 *
 * The names produced here match the vocabulary the consumer already uses
 * (`BRAIN_VIA` in `guard-write.py`): `ask_deepseek_pro`, `ask_deepseek_flash_brain`,
 * `ask_deepseek_flash_brain_fallback`.
 *
 * `ask_deepseek` (the smart router) resolves its tier from complexity keywords at call time, which
 * this module must not re-implement — a second copy of that heuristic would be a second source of
 * truth. Unless the prompt carries an explicit `[pro]`/`[flash]` override, it is labelled without a
 * tier and counted separately rather than guessed into one.
 *
 * @param {string} name tool_use name from the transcript
 * @param {object} [input] tool_use input
 * @returns {string} label stored in `llm_call.tool_names`
 */
export function mcpToolLabel(name, input) {
    const raw = String(name || '');
    if (raw !== 'CallDynamicTool') return raw;

    const toolName = typeof input?.toolName === 'string' ? input.toolName.trim() : '';
    if (!toolName) return raw;

    const prompt = String(input?.arguments?.prompt ?? '').trim();

    if (toolName === 'ask_deepseek_flash') {
        if (BRAIN_FLASH_PREFIX.test(prompt)) return 'mcp:ask_deepseek_flash_brain';
        if (BRAIN_FALLBACK_PREFIX.test(prompt)) return 'mcp:ask_deepseek_flash_brain_fallback';
        return 'mcp:ask_deepseek_flash';
    }

    if (toolName === 'ask_deepseek') {
        const override = ROUTE_OVERRIDE_PREFIX.exec(prompt);
        if (override) {
            return override[1].toLowerCase() === 'pro'
                ? 'mcp:ask_deepseek_pro'
                : 'mcp:ask_deepseek_flash';
        }
        return 'mcp:ask_deepseek_auto';
    }

    return `mcp:${toolName}`;
}

export function cleanArgStr(s) {
    if (typeof s !== 'string') return '';
    let t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1).trim();
    }
    return t;
}

export function extractToolPath(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = [
        'TargetFile', 'target_file', 'targetFile',
        'AbsolutePath', 'absolute_path', 'absolutePath',
        'SearchPath', 'search_path', 'searchPath',
        'DirectoryPath', 'directory_path', 'directoryPath',
        'path', 'filePath', 'file_path', 'notebook_path', 'Url', 'url',
    ];
    for (const k of keys) {
        if (typeof args[k] === 'string' && args[k].trim()) return cleanArgStr(args[k]);
    }
    if (args.Arguments && typeof args.Arguments === 'object') {
        for (const k of keys) {
            if (typeof args.Arguments[k] === 'string' && args.Arguments[k].trim()) {
                return cleanArgStr(args.Arguments[k]);
            }
        }
    }
    return '';
}

export function extractToolCommand(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = ['CommandLine', 'commandLine', 'command', 'cmd', 'script', 'Query', 'query', 'Prompt', 'prompt'];
    for (const k of keys) {
        if (typeof args[k] === 'string' && args[k].trim()) return cleanArgStr(args[k]);
    }
    if (args.Arguments && typeof args.Arguments === 'object') {
        for (const k of keys) {
            if (typeof args.Arguments[k] === 'string' && args.Arguments[k].trim()) {
                return cleanArgStr(args.Arguments[k]);
            }
        }
    }
    return '';
}

export function extractPromptRules(contentText, workspaceRoot) {
    const rules = new Set();
    const text = String(contentText || '');
    for (const m of text.matchAll(/<RULE\[(.*?)\]>/g)) {
        if (m[1]) rules.add(m[1].trim());
    }
    for (const m of text.matchAll(/@\[(.*?)\]/g)) {
        const p = m[1].trim();
        if (/\.mdc$/i.test(p) || /(^|\/)(rules|skills)\//i.test(p) || /(^|\/)AGENTS\.md$/i.test(p)) {
            rules.add(p);
        }
    }
    if (workspaceRoot) {
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        if (fs.existsSync(agentsPath)) {
            rules.add('AGENTS.md');
        }
    }
    const root = String(workspaceRoot || '').replace(/\\/g, '/');
    const out = [];
    for (const r of rules) {
        let s = r.replace(/\\/g, '/');
        if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
        out.push(s);
    }
    return out;
}

/**
 * The prompt a model MCP call was made with, when this `tool_use` is one.
 *
 * Returns null for MCP calls that are not model calls (Jira, chrome-devtools, …): they have no
 * prompt to hash and no tokens worth attributing.
 *
 * @param {string} name tool_use name
 * @param {object} [input] tool_use input
 * @returns {{ tool: string, prompt: string } | null}
 */
export function mcpPromptOf(name, input) {
    if (String(name || '') !== 'CallDynamicTool') return null;
    const toolName = typeof input?.toolName === 'string' ? input.toolName.trim() : '';
    if (!/^ask_deepseek/.test(toolName)) return null;
    const prompt = input?.arguments?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) return null;
    return { tool: mcpToolLabel(name, input), prompt };
}

function pushToolUse(names, tools, emitChars, name, input) {
    tools += 1;
    const label = mcpToolLabel(name, input);
    if (label) names.push(label);
    if (input !== undefined && input !== null) {
        try {
            emitChars += JSON.stringify(input).length;
        } catch {
            /* non-serialisable input */
        }
    }
    return { tools, emitChars };
}

export function assistantStats(msg) {
    const content = (msg && msg.content) || [];
    if (!Array.isArray(content)) {
        return { tools: 0, names: [], textChars: 0, emitChars: 0, preview: '', mcpPrompts: [] };
    }
    let tools = 0;
    let textChars = 0;
    let emitChars = 0;
    let preview = '';
    const names = [];
    const mcpPrompts = [];
    for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') {
            const part = pushToolUse(names, tools, emitChars, b.name, b.input);
            tools = part.tools;
            emitChars = part.emitChars;
            const prompt = mcpPromptOf(b.name, b.input);
            if (prompt) mcpPrompts.push(prompt);
        } else if (b.type === 'function_call' || b.type === 'tool-call' || b.type === 'tool_call') {
            const name = b.name || b.function?.name;
            const input = b.input ?? b.arguments ?? b.function?.arguments;
            const part = pushToolUse(names, tools, emitChars, name, input);
            tools = part.tools;
            emitChars = part.emitChars;
            const prompt = mcpPromptOf(name, input);
            if (prompt) mcpPrompts.push(prompt);
        } else if (b.type === 'text' && typeof b.text === 'string') {
            textChars += b.text.length;
            emitChars += b.text.length;
            if (!preview) preview = b.text.slice(0, 240);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            // No thinking blocks on the current model; branch kept for other models.
            emitChars += b.thinking.length;
        }
    }
    const toolCalls = msg && msg.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!tc || typeof tc !== 'object') continue;
            const part = pushToolUse(
                names,
                tools,
                emitChars,
                tc.name || tc.function?.name,
                tc.input ?? tc.arguments ?? tc.function?.arguments,
            );
            tools = part.tools;
            emitChars = part.emitChars;
        }
    }
    return { tools, names, textChars, emitChars, preview, mcpPrompts };
}

/**
 * Shared with `parse-transcript-calls.mjs` — the single definition of what starts
 * a request. A real prompt is a user line carrying `<user_query>`; Cursor repeats
 * that boundary 2-3x CONSECUTIVELY, so the previous key is what dedupes it.
 */
export function classifyUserLine(msg, lastBoundaryKey) {
    const t = userText(msg);
    const uq = UQ_RE.exec(t);
    if (!uq) return { kind: 'injected' }; // injected context (<external_links>, <uploaded_documents>…)
    const ts = TS_RE.exec(t);
    const query = uq[1].trim();
    const rawTs = ts ? ts[1].trim() : '';
    const key = `${rawTs}\u0000${query}`;
    if (key === lastBoundaryKey) return { kind: 'duplicate', key };
    return { kind: 'boundary', key, query, rawTs, startedAt: parsePromptTs(rawTs) };
}

function getState(db, projectId, sourcePath) {
    return (
        db.get(
            'SELECT * FROM ingest_state WHERE project_id = ? AND source_kind = ? AND source_path = ?',
            [projectId, 'transcript', sourcePath],
        ) || { last_size: 0, last_offset: 0, last_line_no: 0, seam_hash: null }
    );
}

function putState(db, projectId, sourcePath, size, offset, lineNo, error, seamHash = null) {
    db.run(
        `INSERT INTO ingest_state (project_id, source_kind, source_path, last_size, last_offset, last_line_no, last_error, seam_hash, updated_at)
         VALUES (?, 'transcript', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source_kind, source_path) DO UPDATE SET
             last_size = excluded.last_size,
             last_offset = excluded.last_offset,
             last_line_no = excluded.last_line_no,
             last_error = excluded.last_error,
             seam_hash = excluded.seam_hash,
             updated_at = excluded.updated_at`,
        [projectId, sourcePath, size, offset, lineNo, error || null, seamHash, isoNow()],
    );
}

/**
 * Drop every row derived from this transcript and start it over. Used when the
 * file got smaller than our cursor (rotation/truncation) — a rebuild in one
 * transaction is the only safe answer, because keeping half-matched rows would
 * silently mis-number the calls.
 */
function resetConversation(db, projectId, conversationId) {
    const reqs = db.all('SELECT id FROM request WHERE conversation_id = ?', [conversationId]);
    for (const r of reqs) {
        db.run('DELETE FROM llm_call WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM request_rule WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM request_file WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM request_tool WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM check_result WHERE request_id = ?', [r.id]);
        db.run('DELETE FROM request WHERE id = ?', [r.id]);
    }
    db.run('DELETE FROM event WHERE conversation_id = ? AND project_id = ?', [conversationId, projectId]);
    db.run('DELETE FROM request_stop WHERE conversation_id = ? AND project_id = ?', [conversationId, projectId]);
    db.run('UPDATE conversation SET request_count = 0 WHERE id = ?', [conversationId]);
}

/**
 * Throw away everything derived from one transcript and re-read it from byte 0.
 *
 * The seam check above detects a rewritten file from the bytes at the cursor. A cursor written before
 * `seam_hash` existed carries nothing to compare, so a stale offset that happens to land on a newline
 * cannot be detected — for those rows this is the repair.
 *
 * Re-reading from 0 without clearing first would be unsafe, not merely untidy: `nextIndex` continues
 * past the highest existing boundary index, so the first prompt in the file would be stored as request
 * N+1 rather than 1, renumbering the conversation and orphaning the events that reference those ids.
 */
export function rebuildTranscript(db, cfg, transcriptPath) {
    const projectId = cfg.project.id;
    const agyMatch = transcriptPath.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/);
    const conversationId = agyMatch ? agyMatch[1] : path.basename(transcriptPath).replace(/\.jsonl$/, '');
    resetConversation(db, projectId, conversationId);
    db.run('DELETE FROM ingest_state WHERE project_id = ? AND source_kind = ? AND source_path = ?', [
        projectId,
        'transcript',
        transcriptPath,
    ]);
    return ingestTranscript(db, cfg, transcriptPath);
}

/**
 * Ingest one transcript file. Returns a small report so the caller can surface
 * progress (and prove it did something — a no-op with ok:true is the failure
 * mode this tool has already been burned by twice).
 */
export function ingestTranscript(db, cfg, transcriptPath) {
    const projectId = cfg.project.id;
    const agyMatch = transcriptPath.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/);
    const conversationId = agyMatch ? agyMatch[1] : path.basename(transcriptPath).replace(/\.jsonl$/, '');
    const isAntigravity = !!agyMatch || transcriptPath.includes('.gemini/antigravity');
    const now = isoNow();

    if (!fs.existsSync(transcriptPath)) {
        return { path: transcriptPath, conversationId, ok: false, reason: 'missing file' };
    }

    db.run(
        `INSERT INTO conversation (id, project_id, transcript_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET transcript_path = excluded.transcript_path, updated_at = excluded.updated_at`,
        [conversationId, projectId, transcriptPath, now, now],
    );

    let state = getState(db, projectId, transcriptPath);
    /*
     * Read only the bytes appended since the last pass.
     *
     * This used to `readFileSync` the whole transcript and then `subarray(last_offset)`, i.e. it read
     * every byte of every conversation on every poll to process a few hundred new ones. On a machine
     * with many long conversations that is hundreds of MB of synchronous file I/O per cycle, on the
     * server's own thread. The tail is what actually gets parsed, so the tail is what gets read.
     */
    let size;
    try {
        size = fs.statSync(transcriptPath).size;
    } catch {
        return { path: transcriptPath, conversationId, ok: false, reason: 'missing file' };
    }

    let rebuilt = false;
    if (size < state.last_offset) {
        resetConversation(db, projectId, conversationId);
        state = { last_size: 0, last_offset: 0, last_line_no: 0 };
        rebuilt = true;
    } else if (state.last_offset > 0) {
        /*
         * The cursor is a byte offset, and it is only meaningful if the bytes before it are still the
         * ones already consumed. `size < last_offset` catches a truncation, but NOT a rewrite that is
         * at least as long — and then the pass reads the tail from a stale offset, so the prompt line
         * (which is before the cursor) is never seen: nothing is created, the cursor advances to the
         * new size, and the prompt is lost permanently. Observed on a real conversation: cursor at
         * EOF, zero requests, zero llm_calls, `<user_query>` present in the file. Reproduced by
         * rewriting a transcript in place to a longer one.
         *
         * Two checks, cheapest first. The offset must sit directly after a newline, because only
         * complete lines are ever consumed. And the 64 bytes ending at it must hash to what they did
         * when consumed. A row written before `seam_hash` existed has nothing to compare, so it gets
         * the newline check only — `rebuildTranscript` is the repair for the remainder.
         */
        const start = Math.max(0, state.last_offset - SEAM_BYTES);
        const seam = readRange(transcriptPath, start, state.last_offset - start);
        const endsOnNewline = seam.length > 0 && seam[seam.length - 1] === 0x0a;
        const seamMatches = state.seam_hash
            ? crypto.createHash('sha256').update(seam).digest('hex') === state.seam_hash
            : null;
        if (!endsOnNewline || seamMatches === false) {
            resetConversation(db, projectId, conversationId);
            state = { last_size: 0, last_offset: 0, last_line_no: 0 };
            rebuilt = true;
        }
    }

    const text = readRange(transcriptPath, state.last_offset, size - state.last_offset).toString('utf8');
    const parts = text.split('\n');
    const completeCount = text.endsWith('\n') ? parts.length - 1 : Math.max(0, parts.length - 1);

    const report = { path: transcriptPath, conversationId, ok: true, rebuilt, newLines: 0, newRequests: 0, newCalls: 0 };
    const touched = new Set();

    if (completeCount === 0) {
        db.run('UPDATE conversation SET byte_size = ?, updated_at = ? WHERE id = ?', [size, now, conversationId]);
        report.touchedRequests = [];
        return report;
    }

    db.tx(() => {
        // Resume the open request: the one with the highest boundary index. Its
        // calls may still be arriving, so we append to it rather than restarting.
        let current = db.get(
            'SELECT * FROM request WHERE conversation_id = ? ORDER BY boundary_index DESC LIMIT 1',
            [conversationId],
        );
        let nextIndex = current ? current.boundary_index + 1 : 1;
        let lastBoundaryKey = null;
        let callIndex = current
            ? db.get('SELECT COUNT(*) AS n FROM llm_call WHERE request_id = ?', [current.id]).n
            : 0;

        let currentModel = db.get(
            'SELECT model_id FROM request WHERE conversation_id = ? AND model_id IS NOT NULL ORDER BY boundary_index DESC LIMIT 1',
            [conversationId],
        )?.model_id || null;
        let conversationChars = 0;

        let offset = state.last_offset;
        let lineNo = state.last_line_no;

        for (let i = 0; i < completeCount; i += 1) {
            const line = parts[i];
            offset += Buffer.byteLength(line, 'utf8') + 1;
            lineNo += 1;
            if (!line.trim()) continue;
            report.newLines += 1;

            let rec;
            try {
                rec = JSON.parse(line);
            } catch {
                continue; // a half-flushed line is not fatal; the next pass retries it
            }

            if (isAntigravity) {
                const lineCharCount = line.length;
                const contentText = typeof rec.content === 'string' ? rec.content : '';
                const modelM = /The user changed setting [`']?Model Selection[`']? from .+? to [`']?(.+?)[`']?(?:\.\s+(?:No need|[A-Z])|\.\s*$|\n|$)/i.exec(contentText);
                if (modelM && modelM[1]) {
                    currentModel = modelM[1].trim();
                }

                // ---- Antigravity: user prompt
                if (rec.source === 'USER_EXPLICIT' && rec.type === 'USER_INPUT') {
                    const ur = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(contentText);
                    const uq = UQ_RE.exec(contentText);
                    const query = ur ? ur[1].trim() : (uq ? uq[1].trim() : contentText.trim());
                    if (!query) {
                        conversationChars += lineCharCount;
                        continue;
                    }
                    const rawTs = rec.created_at || now;
                    const key = `${rawTs}\u0000${query}`;
                    if (key === lastBoundaryKey) {
                        conversationChars += lineCharCount;
                        continue;
                    }
                    lastBoundaryKey = key;
                    const startedAt = parsePromptTs(rawTs) || rawTs;

                    if (current) {
                        const callStats = db.get(
                            `SELECT COUNT(*) AS calls, COALESCE(SUM(tool_count), 0) AS tools,
                                    COALESCE(SUM(text_chars), 0) AS textChars,
                                    COALESCE(SUM(emit_chars), 0) AS emitChars
                             FROM llm_call WHERE request_id = ?`,
                            [current.id],
                        );
                        const outTokens = callStats?.emitChars ? Math.round(callStats.emitChars / 4) : null;
                        const inTokens = Math.round(conversationChars / 4);
                        db.run(
                            `UPDATE request SET status = CASE WHEN status = 'in_progress' THEN 'completed' ELSE status END,
                                ended_at = COALESCE(ended_at, ?),
                                input_tokens = COALESCE(input_tokens, ?),
                                output_tokens = COALESCE(output_tokens, ?),
                                model_id = COALESCE(model_id, ?),
                                updated_at = ? WHERE id = ?`,
                            [startedAt, inTokens > 0 ? inTokens : null, outTokens > 0 ? outTokens : null, currentModel, now, current.id],
                        );
                    }

                    const reqId = `${conversationId}:${nextIndex}`;
                    db.run(
                        `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
                            started_at, status, generation_id, model_id, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET user_query = excluded.user_query, started_at = excluded.started_at,
                            generation_id = COALESCE(request.generation_id, excluded.generation_id),
                            model_id = COALESCE(request.model_id, excluded.model_id),
                            updated_at = excluded.updated_at`,
                        [reqId, projectId, conversationId, nextIndex, query, rawTs, startedAt, reqId, currentModel, now, now],
                    );
                    current = {
                        id: reqId,
                        boundary_index: nextIndex,
                        status: 'in_progress',
                        call_count: 0,
                    };
                    nextIndex += 1;
                    callIndex = 0;
                    report.newRequests += 1;
                    touched.add(reqId);

                    const promptRules = extractPromptRules(contentText, cfg.root);
                    for (const r of promptRules) {
                        db.run(
                            `INSERT INTO request_rule (request_id, rule_id, attached_at) VALUES (?, ?, ?)
                             ON CONFLICT(request_id, rule_id) DO NOTHING`,
                            [reqId, r, startedAt],
                        );
                    }

                    conversationChars += lineCharCount;
                    continue;
                }

                // ---- Antigravity: LLM call (assistant response)
                if (rec.source === 'MODEL' && rec.type === 'PLANNER_RESPONSE') {
                    if (!current) {
                        conversationChars += lineCharCount;
                        continue;
                    }
                    const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
                    const tools = toolCalls.length;
                    const names = toolCalls.map((tc) => tc.name).filter(Boolean);
                    const contentText = typeof rec.content === 'string' ? rec.content : '';
                    let textChars = contentText.length;
                    let emitChars = contentText.length;
                    for (const tc of toolCalls) {
                        if (tc.args !== undefined && tc.args !== null) {
                            try {
                                emitChars += JSON.stringify(tc.args).length;
                            } catch {}
                        }
                    }
                    let preview = contentText.slice(0, 240);
                    if (!preview.trim() && toolCalls.length > 0) {
                        preview = toolCalls.map((tc) => {
                            const p = extractToolPath(tc.args);
                            const c = extractToolCommand(tc.args);
                            return [tc.name, p || c].filter(Boolean).join(' ');
                        }).join('; ').slice(0, 240);
                    }
                    callIndex += 1;
                    const callId = `${current.id}:${callIndex}`;
                    db.run(
                        `INSERT INTO llm_call (id, project_id, request_id, call_index, file_line_no, tool_count, text_chars, emit_chars, tool_names, preview, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                             tool_count = excluded.tool_count, text_chars = excluded.text_chars,
                             emit_chars = excluded.emit_chars, tool_names = excluded.tool_names, preview = excluded.preview`,
                        [
                            callId,
                            projectId,
                            current.id,
                            callIndex,
                            lineNo,
                            tools,
                            textChars,
                            emitChars,
                            names.join(','),
                            preview,
                            now,
                        ],
                    );

                    const relLog = path.relative(cfg.root, transcriptPath).replace(/\\/g, '/');
                    for (let ti = 0; ti < toolCalls.length; ti += 1) {
                        const tc = toolCalls[ti];
                        const toolName = tc.name === 'call_mcp_tool' && tc.args?.ToolName
                            ? tc.args.ToolName
                            : (tc.name || 'tool');
                        let pathVal = extractToolPath(tc.args);
                        const cmdVal = extractToolCommand(tc.args);
                        if (cfg.root && pathVal.replace(/\\/g, '/').startsWith(`${cfg.root}/`)) {
                            pathVal = pathVal.replace(/\\/g, '/').slice(cfg.root.length + 1);
                        }
                        const rawObj = {
                            harness: 'agents',
                            eventType: 'postToolUse',
                            tool: toolName,
                            path: pathVal || null,
                            command: cmdVal || null,
                            payload: {
                                tool_input: {
                                    command: cmdVal || null,
                                    path: pathVal || null,
                                },
                            },
                        };
                        db.run(
                            `INSERT INTO event (project_id, harness, event_type, tool, path, generation_id,
                                conversation_id, request_id, hook_at, source_path, source_line_no, raw_json)
                             VALUES (?, 'agents', 'postToolUse', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(project_id, harness, source_path, source_line_no) DO UPDATE SET
                                tool = excluded.tool, path = excluded.path, request_id = excluded.request_id,
                                generation_id = excluded.generation_id, hook_at = excluded.hook_at, raw_json = excluded.raw_json`,
                            [
                                projectId,
                                toolName,
                                pathVal || null,
                                current.id,
                                conversationId,
                                current.id,
                                rec.created_at || now,
                                relLog,
                                lineNo * 1000 + ti,
                                JSON.stringify(rawObj),
                            ],
                        );

                        if (pathVal && (/\.mdc$/i.test(pathVal) || /(^|\/)(rules|skills)\//i.test(pathVal) || /(^|\/)AGENTS\.md$/i.test(pathVal))) {
                            db.run(
                                `INSERT INTO request_rule (request_id, rule_id, attached_at) VALUES (?, ?, ?)
                                 ON CONFLICT(request_id, rule_id) DO NOTHING`,
                                [current.id, pathVal, rec.created_at || now],
                            );
                        }
                    }

                    report.newCalls += 1;
                    touched.add(current.id);
                    conversationChars += lineCharCount;
                    continue;
                }

                if (rec.status === 'ERROR' && current) {
                    db.run(`UPDATE request SET has_failures = 1 WHERE id = ?`, [current.id]);
                }
                conversationChars += lineCharCount;
                continue;
            }

            // ---- turn_ended: the agent stopped; this finalises the open request
            if (rec.type === 'turn_ended') {
                if (current) {
                    const status = rec.status === 'error' ? 'error' : 'completed';
                    db.run(
                        `UPDATE request SET status = ?, has_failures = ?, ended_at = COALESCE(ended_at, ?), updated_at = ?
                         WHERE id = ?`,
                        [status, rec.status === 'error' ? 1 : 0, now, now, current.id],
                    );
                    current.status = status;
                }
                continue;
            }

            // ---- a real user prompt: close the previous request, open a new one
            if (rec.role === 'user') {
                const boundary = classifyUserLine(rec.message, lastBoundaryKey);
                if (boundary.kind !== 'boundary') continue; // injected context, or a repeated boundary
                lastBoundaryKey = boundary.key;

                // finalise the request we are leaving; its end is this prompt's start
                if (current) {
                    db.run(
                        `UPDATE request SET status = CASE WHEN status = 'in_progress' THEN 'completed' ELSE status END,
                            ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`,
                        [boundary.startedAt, now, current.id],
                    );
                }

                const reqId = `${conversationId}:${nextIndex}`;
                db.run(
                    `INSERT INTO request (id, project_id, conversation_id, boundary_index, user_query, prompt_at,
                        started_at, status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)
                     ON CONFLICT(id) DO UPDATE SET user_query = excluded.user_query, updated_at = excluded.updated_at`,
                    [reqId, projectId, conversationId, nextIndex, boundary.query, boundary.rawTs, boundary.startedAt, now, now],
                );
                current = {
                    id: reqId,
                    boundary_index: nextIndex,
                    status: 'in_progress',
                    call_count: 0,
                };
                nextIndex += 1;
                callIndex = 0;
                report.newRequests += 1;
                touched.add(reqId);
                continue;
            }

            // ---- one assistant message == one LLM call
            if (rec.role === 'assistant') {
                if (!current) continue; // pre-prompt context; nothing to attribute it to
                const st = assistantStats(rec.message);
                callIndex += 1;
                const callId = `${current.id}:${callIndex}`;
                db.run(
                    `INSERT INTO llm_call (id, project_id, request_id, call_index, file_line_no, tool_count, text_chars, emit_chars, tool_names, preview, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                         tool_count = excluded.tool_count, text_chars = excluded.text_chars,
                         emit_chars = excluded.emit_chars, tool_names = excluded.tool_names, preview = excluded.preview`,
                    [
                        callId,
                        projectId,
                        current.id,
                        callIndex,
                        lineNo,
                        st.tools,
                        st.textChars,
                        st.emitChars,
                        st.names.join(','),
                        st.preview,
                        now,
                    ],
                );
                report.newCalls += 1;
                recordMcpPrompts(db, projectId, conversationId, current.id, callId, st.mcpPrompts, now);
                touched.add(current.id);
            }
        }

        // Recompute the request aggregates from the calls we just wrote, so a
        // resumed pass and a from-scratch pass produce identical numbers.
        db.run(
            `UPDATE request SET
                call_count = (SELECT COUNT(*) FROM llm_call WHERE request_id = request.id),
                tool_count = (SELECT COALESCE(SUM(tool_count), 0) FROM llm_call WHERE request_id = request.id),
                text_chars = (SELECT COALESCE(SUM(text_chars), 0) FROM llm_call WHERE request_id = request.id),
                output_tokens = CASE
                    WHEN output_tokens IS NULL THEN (SELECT ROUND(COALESCE(SUM(emit_chars), 0) / 4.0) FROM llm_call WHERE request_id = request.id)
                    ELSE output_tokens
                END,
                model_id = COALESCE(?, model_id),
                updated_at = ?
             WHERE conversation_id = ?`,
            [currentModel, now, conversationId],
        );
        if (current) {
            const lastStats = db.get(
                `SELECT COALESCE(SUM(emit_chars), 0) AS emitChars FROM llm_call WHERE request_id = ?`,
                [current.id],
            );
            const inTokens = Math.round(conversationChars / 4);
            const outTokens = lastStats?.emitChars ? Math.round(lastStats.emitChars / 4) : null;
            db.run(
                `UPDATE request SET status = CASE WHEN status = '' THEN 'in_progress' ELSE status END,
                    input_tokens = COALESCE(input_tokens, ?),
                    output_tokens = COALESCE(output_tokens, ?),
                    model_id = COALESCE(model_id, ?)
                 WHERE id = ?`,
                [inTokens > 0 ? inTokens : null, outTokens > 0 ? outTokens : null, currentModel, current.id],
            );
        }

        // Backfill input_tokens for any requests in this conversation that still have input_tokens IS NULL
        const reqsWithoutInput = db.all(
            `SELECT id, boundary_index, length(user_query) AS qlen FROM request
             WHERE conversation_id = ? AND input_tokens IS NULL AND call_count > 0 ORDER BY boundary_index`,
            [conversationId],
        );
        for (const rw of reqsWithoutInput) {
            const prevStats = db.get(
                `SELECT COALESCE(SUM(lc.text_chars + lc.emit_chars), 0) AS priorChars
                 FROM llm_call lc
                 JOIN request r ON r.id = lc.request_id
                 WHERE r.conversation_id = ? AND r.boundary_index < ?`,
                [conversationId, rw.boundary_index],
            );
            const estIn = Math.round(((prevStats?.priorChars || 0) + rw.qlen + 1500) / 4);
            if (estIn > 0) {
                db.run('UPDATE request SET input_tokens = ? WHERE id = ?', [estIn, rw.id]);
            }
        }

        const agg = db.get(
            `SELECT COUNT(*) AS n, MIN(started_at) AS started, MAX(COALESCE(ended_at, started_at)) AS ended
             FROM request WHERE conversation_id = ?`,
            [conversationId],
        );
        db.run(
            `UPDATE conversation SET byte_size = ?, line_count = ?, request_count = ?, started_at = ?, ended_at = ?, updated_at = ?
             WHERE id = ?`,
            [size, lineNo, agg ? agg.n : 0, agg ? agg.started : null, agg ? agg.ended : null, now, conversationId],
        );
        putState(db, projectId, transcriptPath, size, offset, lineNo, null, seamHashOf(transcriptPath, offset));
    });

    report.touchedRequests = [...touched];
    return report;
}

/**
 * Persist the prompts a model MCP call was made with, keyed by prompt hash.
 *
 * The MCP server records `sha256(prompt)` in its usage ledger because a prompt is the only thing it
 * receives; this is the other half, saying which request sent that prompt.
 */
function recordMcpPrompts(db, projectId, conversationId, requestId, llmCallId, prompts, now) {
    if (!Array.isArray(prompts) || !prompts.length) return;
    for (const { tool, prompt } of prompts) {
        insertPromptRow(db, { projectId, conversationId, requestId, llmCallId, tool, prompt, now });
    }
}

function relPath(cfg, p) {
    const root = (cfg.root || '').replace(/\\/g, '/');
    const s = String(p || '').replace(/\\/g, '/');
    if (!s) return '';
    if (root && s.startsWith(root + '/')) return s.slice(root.length + 1);
    if (!path.isAbsolute(s)) return s.replace(/^\.\//, '');
    try {
        const rel = path.relative(cfg.root, s);
        if (!rel || rel.startsWith('..')) return s;
        return rel.split(path.sep).join('/');
    } catch {
        return s;
    }
}

/**
 * Build a `turn_start` event for `decide()` from ingested request evidence (WP4).
 *
 * @param {import('./db.mjs').Db} db
 * @param {object} cfg
 * @param {string} requestId
 * @returns {import('./decision-types.mjs').DecisionEvent|null}
 */
export function buildRequestDecisionContext(db, cfg, requestId) {
    const req = db.get(
        'SELECT id, conversation_id, generation_id, user_query FROM request WHERE id = ? AND project_id = ?',
        [requestId, cfg.project.id],
    );
    if (!req) return null;

    const files = db.all('SELECT path FROM request_file WHERE request_id = ?', [requestId]);
    const touchedPaths = [...new Set(files.map((f) => relPath(cfg, f.path)).filter(Boolean))];

    const rules = db.all('SELECT rule_id FROM request_rule WHERE request_id = ?', [requestId]);
    const stem = String(req.user_query || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);

    return {
        event: 'turn_start',
        sessionId: req.conversation_id || req.generation_id || undefined,
        turnId: req.id,
        userQueryStem: stem,
        touchedPaths,
        hookMeta: {
            attachedRules: rules.map((r) => r.rule_id),
            generationId: req.generation_id,
        },
    };
}

/** Every transcript file belonging to THIS project (never another project's). */
/**
 * Antigravity writes `Active Document: <path> (LANGUAGE_X)` and a bullet list of other open
 * documents, each with the same suffix. The suffix is not part of the path.
 */
const AG_DOC_SUFFIX_RE = /\s*\((?:LANGUAGE_[A-Z_]+|UNSPECIFIED)\)\s*$/;

/** @param {string} line */
function docPath(line) {
    return String(line).replace(AG_DOC_SUFFIX_RE, '').trim();
}

/**
 * Remap a document path from the transcript to a path accessible on the current filesystem
 * (especially inside Docker where host workspace paths are mounted at /data/repo or /agent-repos).
 */
function toContainerPath(filePath) {
    if (!filePath) return filePath;
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved)) return resolved;

    const repoHost = process.env.HARNESS_REPO_ROOT_HOST ? path.resolve(process.env.HARNESS_REPO_ROOT_HOST) : null;
    if (repoHost && (resolved === repoHost || resolved.startsWith(`${repoHost}${path.sep}`))) {
        return path.join('/data/repo', path.relative(repoHost, resolved));
    }

    const agentHost = process.env.HARNESS_AGENT_ROOT_HOST ? path.resolve(process.env.HARNESS_AGENT_ROOT_HOST) : null;
    const mount = process.env.HARNESS_AGENT_MOUNT || '/agent-repos';
    if (agentHost && (resolved === agentHost || resolved.startsWith(`${agentHost}${path.sep}`))) {
        return path.join(mount, path.relative(agentHost, resolved));
    }

    return resolved;
}

/**
 * Remap a container path back to its canonical host path, if running in a mounted container.
 */
function toHostPath(dirPath) {
    if (!dirPath) return dirPath;
    const resolved = path.resolve(dirPath);

    if (process.env.HARNESS_REPO_ROOT_HOST && (resolved === '/data/repo' || resolved.startsWith(`/data/repo${path.sep}`))) {
        return path.join(path.resolve(process.env.HARNESS_REPO_ROOT_HOST), path.relative('/data/repo', resolved));
    }

    const mount = process.env.HARNESS_AGENT_MOUNT || '/agent-repos';
    if (process.env.HARNESS_AGENT_ROOT_HOST && (resolved === mount || resolved.startsWith(`${mount}${path.sep}`))) {
        return path.join(path.resolve(process.env.HARNESS_AGENT_ROOT_HOST), path.relative(mount, resolved));
    }

    return resolved;
}

/** Nearest ancestor of `filePath` that holds a `harness.config.json`, or a repo root (.git / .agents), or null. */
function projectRootOf(filePath) {
    const cPath = toContainerPath(filePath);
    let cur = path.dirname(cPath);
    let repoRoot = null;
    for (let i = 0; i < 24; i += 1) {
        if (fs.existsSync(path.join(cur, 'harness.config.json'))) return toHostPath(cur);
        if (!repoRoot && (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, '.agents')))) {
            repoRoot = toHostPath(cur);
        }
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
    }
    return repoRoot;
}

function isOwnerMatchingProject(owner, cfgRoot) {
    if (!owner) return false;
    const normOwner = path.resolve(owner);
    const normRoot = path.resolve(cfgRoot);
    if (normOwner === normRoot) return true;

    const hostRoot = process.env.HARNESS_REPO_ROOT_HOST ? path.resolve(process.env.HARNESS_REPO_ROOT_HOST) : null;
    if (hostRoot && normOwner === hostRoot) return true;

    try {
        const sOwner = fs.statSync(toContainerPath(normOwner));
        const sRoot = fs.statSync(toContainerPath(normRoot));
        if (sOwner.dev === sRoot.dev && sOwner.ino === sRoot.ino) return true;
    } catch {}

    return false;
}

/**
 * Detailed owner resolution result including whether the transcript has IDE window metadata.
 *
 * @param {string} transcriptPath
 * @returns {{ owner: string | null, hasMetadata: boolean }}
 */
export function resolveTranscriptOwnerInfo(transcriptPath) {
    let text;
    try {
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(131072);
        const read = fs.readSync(fd, buf, 0, 131072, 0);
        fs.closeSync(fd);
        text = buf.subarray(0, read).toString('utf8');
    } catch {
        return { owner: null, hasMetadata: false };
    }

    // Records are newline-delimited JSON; the metadata arrives with the first user turn.
    let metadata = '';
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue; // a half-written trailing line
        }
        if (typeof record?.content !== 'string') continue;
        if (record.content.includes('Active Document:')) {
            metadata = record.content;
            break;
        }
    }
    if (!metadata) return { owner: null, hasMetadata: false };

    const votes = new Map();
    const vote = (docLine) => {
        const root = projectRootOf(docPath(docLine));
        if (root) votes.set(root, (votes.get(root) ?? 0) + 1);
    };

    const active = /Active Document: ([^\n]+)/.exec(metadata);
    if (active) vote(active[1]);

    const listStart = metadata.indexOf('Other open documents:');
    if (listStart !== -1) {
        for (const line of metadata.slice(listStart).split('\n').slice(1)) {
            const m = /^\s*-\s+(.+?)\s*$/.exec(line);
            if (!m) break; // the list is contiguous; anything else ends it
            vote(m[1]);
        }
    }

    if (!votes.size) return { owner: null, hasMetadata: true };
    // The focused document wins ties: insertion order puts it first.
    let winner = null;
    let best = 0;
    for (const [root, count] of votes) {
        if (count > best) {
            best = count;
            winner = root;
        }
    }
    return { owner: winner, hasMetadata: true };
}

/**
 * The harness project root that owns an Antigravity conversation, or `null` when the transcript
 * records no usable signal.
 *
 * Antigravity's brain directory is **global** (`~/.gemini/antigravity-ide/brain`), so every configured
 * project scans every conversation, and the only filter used to be "does this file mention my root
 * anywhere". That is not ownership: an agent routinely `cd`s into sibling repositories to inspect
 * them, so a single baplatform conversation contained the x79 path 74 times — and both projects
 * ingested it into their own databases. One transcript, two owners, and the observatory showed the
 * same requests under both.
 *
 * What the transcript does record is the window's open documents, in `ADDITIONAL_METADATA`. Mapping
 * those to the nearest `harness.config.json` and taking the most frequent answer is deterministic, and
 * it matches how the rest of the system decides which project a path belongs to. The focused document
 * votes first, so a single stray file opened from another repo cannot outvote the actual workspace.
 *
 * The records must be **parsed**, not pattern-matched on the raw bytes: inside the JSON each newline
 * in the metadata is the two-character escape `\n`, so a `[^\n]+` match runs past the document line
 * and swallows the rest of the block, yielding a path that resolves to nothing. That mistake made this
 * function return `null` for every real transcript while passing hand-built fixtures.
 *
 * @param {string} transcriptPath
 * @returns {string | null} absolute project root
 */
export function resolveTranscriptOwner(transcriptPath) {
    return resolveTranscriptOwnerInfo(transcriptPath).owner;
}

export function discoverTranscripts(cfg) {
    const dir = cfg.ingest.transcriptDir;
    const out = [];
    if (dir && fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                out.push(path.join(dir, entry.name));
            } else if (entry.isDirectory()) {
                const inner = path.join(dir, entry.name, `${entry.name}.jsonl`);
                if (fs.existsSync(inner)) out.push(inner);
            }
        }
    }

    const brainDirs = cfg.ingest.brainDirs || [];
    const root = path.resolve(cfg.root);
    for (const bDir of brainDirs) {
        if (!fs.existsSync(bDir)) continue;
        for (const entry of fs.readdirSync(bDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const logFile = path.join(bDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
            if (!fs.existsSync(logFile)) continue;

            const { owner, hasMetadata } = resolveTranscriptOwnerInfo(logFile);
            if (owner) {
                /*
                 * The transcript names its workspace: that is authoritative. A project that is merely
                 * mentioned in the conversation does not get to claim it.
                 */
                if (isOwnerMatchingProject(owner, root)) out.push(logFile);
                continue;
            }

            if (hasMetadata) {
                /*
                 * The transcript has window metadata, but none of its documents belong to this project
                 * (e.g. documents are in a sibling repo without harness or outside any project).
                 * Do NOT fall back to substring matching — mentioning a sibling project path must never claim it.
                 */
                continue;
            }

            /*
             * No usable signal (conversations from before the metadata existed). Fall back to the
             * historical substring check, which stays safe for these: measured across every stored
             * conversation, none of the signal-less ones mention more than one project root.
             */
            try {
                const fd = fs.openSync(logFile, 'r');
                const buf = Buffer.alloc(131072);
                const read = fs.readSync(fd, buf, 0, 131072, 0);
                fs.closeSync(fd);
                const text = buf.subarray(0, read).toString('utf8');
                const hostRoot = process.env.HARNESS_REPO_ROOT_HOST ? path.resolve(process.env.HARNESS_REPO_ROOT_HOST) : root;
                if (text.includes(hostRoot) || (root !== '/data/repo' && text.includes(root))) {
                    out.push(logFile);
                }
            } catch {
                /* skip unreadable file */
            }
        }
    }

    return out.sort();
}
