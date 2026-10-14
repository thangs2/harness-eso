/**
 * Storage for the model prompts an agent sent through an MCP server.
 *
 * Two writers need this: live ingest (as it reads new transcript bytes) and the one-time history
 * backfill. Both must produce the same row id, or a prompt recorded by one would be inserted again
 * by the other — so the id and the insert live here rather than being written twice.
 *
 * The row is keyed by conversation + `sha256(prompt)` because that is the only identifier the MCP
 * server and the observer share: an MCP server is handed a prompt and nothing else.
 */
import crypto from 'node:crypto';
import { isoNow } from './observe-config.mjs';

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
    const sha = sha256Hex(row.prompt);
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
            String(row.prompt).length,
            row.now ?? isoNow(),
        ],
    );
    return id;
}
