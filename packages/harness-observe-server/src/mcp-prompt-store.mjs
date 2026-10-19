/**
 * Storage for the model prompts an agent sent through an MCP server.
 *
 * Two writers need this: live ingest (as it reads new transcript bytes) and the one-time history
 * backfill. Both must produce the same row id, or a prompt recorded by one would be inserted again
 * by the other — so the id and the insert live here rather than being written twice.
 *
 * The row is keyed by conversation + `sha256(usageHashPrompt(prompt))` because that is the only
 * identifier the MCP server and the observer share. The MCP server strips role/route prefixes
 * before calling the model and hashes that stripped body into the usage ledger — so this side must
 * hash the same body, not the raw transcript argument (which still carries `[BRAIN FLASH]` etc.).
 */
import crypto from 'node:crypto';
import { isoNow } from './observe-config.mjs';

/**
 * Must stay byte-identical to the DeepSeek MCP server's strip before `callDeepSeek`
 * (`BRAIN_FLASH_PREFIX` / `BRAIN_FALLBACK_PREFIX` / `ROUTE_OVERRIDE_RE` in deepseek-direct).
 * The ledger's `promptSha256` is `sha256` of the result — joining on the raw transcript prompt
 * silently attributes nothing for every Brain call.
 */
const BRAIN_FALLBACK_PREFIX = /^\[BRAIN FALLBACK\]\s*/i;
const BRAIN_FLASH_PREFIX = /^\[BRAIN FLASH\]\s*/i;
const ROUTE_OVERRIDE_PREFIX = /^\[(flash|pro)\]\s*/i;

/**
 * Prompt body the DeepSeek MCP server hashes into the usage ledger.
 *
 * @param {unknown} prompt
 * @returns {string}
 */
export function usageHashPrompt(prompt) {
    const text = String(prompt ?? '');
    const trimmed = text.trim();
    if (BRAIN_FALLBACK_PREFIX.test(trimmed)) {
        return text.replace(BRAIN_FALLBACK_PREFIX, '').trim();
    }
    if (BRAIN_FLASH_PREFIX.test(trimmed)) {
        return text.replace(BRAIN_FLASH_PREFIX, '').trim();
    }
    if (ROUTE_OVERRIDE_PREFIX.test(trimmed)) {
        return text.replace(ROUTE_OVERRIDE_PREFIX, '').trim();
    }
    return text;
}

export function sha256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Same prompt in the same conversation is the same row; across conversations it is not. */
export function mcpPromptId(conversationId, promptSha256) {
    return `${conversationId}\u0000${promptSha256}`;
}

/**
 * @param {import('./observe-db.mjs').Db} db
 * @param {{
 *   projectId: string, conversationId: string, requestId: string,
 *   llmCallId?: string | null, tool: string, prompt: string, now?: string,
 * }} row
 * @returns {string} the row id
 */
export function insertPromptRow(db, row) {
    const forHash = usageHashPrompt(row.prompt);
    const sha = sha256Hex(forHash);
    const id = mcpPromptId(row.conversationId, sha);
    db.run(
        `INSERT INTO mcp_prompt (id, project_id, conversation_id, request_id, llm_call_id, tool, prompt_sha256, prompt_chars, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             request_id = excluded.request_id,
             llm_call_id = excluded.llm_call_id,
             tool = excluded.tool,
             prompt_chars = excluded.prompt_chars`,
        [
            id,
            row.projectId,
            row.conversationId,
            row.requestId,
            row.llmCallId ?? null,
            row.tool,
            sha,
            forHash.length,
            row.now ?? isoNow(),
        ],
    );
    return id;
}
