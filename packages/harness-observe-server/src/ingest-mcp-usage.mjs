/**
 * Ingest the model-usage ledger the DeepSeek MCP server writes.
 *
 * Why a ledger at all: a Cursor turn's cost is mostly spent inside MCP model calls, and no other
 * channel records it. Cursor's `stop` hook reports only the Dispatcher's own usage, and the agent
 * transcript carries no usage field — so a turn that made twelve Brain calls looked like it cost
 * only the dispatcher's tokens.
 *
 * Attribution, and why it is done this way: an MCP server is handed a prompt and nothing else. It
 * knows no conversation, no generation, no workspace. The one identifier both sides share is the
 * prompt body the server actually hashes — after it strips `[BRAIN FLASH]` / `[BRAIN FALLBACK]` /
 * `[pro]` / `[flash]` (see `usageHashPrompt`). The ledger records `sha256` of that body; the
 * transcript side records the same hash via `mcp_prompt`. Joining on the raw transcript argument
 * (which still carries the prefix) attributes nothing for Brain calls. The alternative — matching
 * by timestamp — misattributes whenever two turns overlap, which is the normal case for anyone
 * running more than one agent at a time.
 *
 * Records that match nothing are kept with a null `request_id` rather than dropped: a prompt the
 * observer cannot place is still evidence that spend happened, and silently discarding it would
 * recreate the original problem in a subtler form.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { productStateDir } from '@mu/harness-foundation';
import { isoNow } from './observe-config.mjs';
import { insertPromptRow, sha256Hex } from './mcp-prompt-store.mjs';
import { parseTranscriptCalls } from './parse-transcript-calls.mjs';

/**
 * Where the MCP server writes, and where this reads.
 *
 * One rule, deliberately: `<product-state>/deepseek-usage.jsonl`. That resolves to `~/.harness` on
 * the host and `/data/product-state` in Docker — and the compose file already bind-mounts the
 * latter to the operator's `~/.harness`. So the host-side MCP server and the container-side ingest
 * name the same file without a second mount, and without either side guessing the other's layout.
 *
 * It used to be `<dataRoot>/deepseek-usage.jsonl`. That happens to be the same directory on the
 * host, which is why local development worked, but `HARNESS_DATA_ROOT` in Docker is a **named
 * volume** holding per-project databases — a container-only filesystem the host MCP server cannot
 * see. The bug was invisible until the two ran in different places.
 *
 * The ledger is machine-wide product state written by a host process, not per-project observe data,
 * which is why product state is the correct home rather than the data root.
 *
 * `DEEPSEEK_USAGE_LEDGER` overrides it on both sides — the MCP server is a standalone script that
 * cannot import this module, so an explicit override is the only way to point both at a shared
 * volume without duplicating the resolution rule.
 */
export function defaultUsageLedgerPath() {
    const override = process.env.DEEPSEEK_USAGE_LEDGER?.trim();
    if (override) return override;
    return path.join(productStateDir(), 'deepseek-usage.jsonl');
}

/**
 * @param {string} filePath
 * @returns {object[]} parsed records; malformed lines are skipped, a missing file yields []
 */
export function readUsageLedger(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            out.push(JSON.parse(trimmed));
        } catch {
            // A half-flushed last line, or a hand-edited file. Neither should stop the ingest.
        }
    }
    return out;
}

/**
 * Stable identity for one ledger record, so re-reading the file is idempotent.
 *
 * `projectId` is part of the key because the ledger is **machine-wide** while every project reads the
 * whole file. Without it, two projects computing an id for the same record produced the *same* id,
 * and `ON CONFLICT(id) DO NOTHING` let whichever project ingested first keep the row. The project
 * that actually owned the prompt then found nothing to insert and reported the record as `skipped` —
 * its spend was lost, and the first project showed it as unattributed. That is the opposite of what
 * this module intends, and it went unnoticed only because one project was registered at the time.
 *
 * The consequence of scoping the key: one physical call can exist as a row in several projects'
 * databases. Only the owning project can attribute it (through `mcp_prompt`), and only attributed
 * rows feed `mcp_call_stats`, so no project's totals count another's spend. The duplication is
 * bounded and mutually invisible, which is the trade this makes against losing spend outright.
 */
function recordId(projectId, record) {
    const key = [
        projectId,
        record.at ?? '',
        record.role ?? '',
        record.promptSha256 ?? '',
        record.model ?? '',
        record.attempt ?? '',
    ].join('\u0000');
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 40);
}

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Prefer the transcript-resolved label on `mcp_prompt`; otherwise map the ledger `role` so
 * `refreshMcpCallStats` can classify the row without waiting for attribution.
 *
 * @param {object} record ledger line
 * @param {string | null | undefined} ownerTool
 */
export function toolLabelForLedgerRecord(record, ownerTool) {
    if (ownerTool) return ownerTool;
    const role = String(record?.role || '');
    if (role === 'pro') return 'mcp:ask_deepseek_pro';
    if (role === 'brain_flash') return 'mcp:ask_deepseek_flash_brain';
    if (role === 'brain_fallback') return 'mcp:ask_deepseek_flash_brain_fallback';
    if (role === 'executor') return 'mcp:ask_deepseek_flash';
    return `mcp:${record?.model ?? 'unknown'}`;
}

/**
 * Version of the history walk. Bump when the walk starts deriving something new, so conversations
 * processed by an older version are revisited instead of keeping stale derivations forever.
 *
 *   1 — recorded model prompts
 *   2 — also re-resolved `llm_call.tool_names` from the wrapper name
 *   3 — hash `usageHashPrompt(prompt)` (strip Brain/route prefixes) so ledger joins match
 */
const MCP_BACKFILL_VERSION = 3;

/**
 * Walk history once per conversation and recover what live ingest could not have known.
 *
 * Two jobs, both about *already-ingested* bytes:
 *
 *   1. Re-resolve tool labels. Before this existed every MCP call was stored as `CallDynamicTool`,
 *      so `mcp_call_stats` reported zero Brain and zero Pro for every turn already on disk. The
 *      counts are recoverable exactly, because the transcript still holds the input.
 *   2. Record model prompts, so the provider's usage ledger has something to join on.
 *
 * One pass per conversation is enough: history is covered here, and anything appended afterwards is
 * covered by live ingest. `parseTranscriptCalls` is the same pure walker that owns the boundary
 * rules, so the ids derived here cannot drift from the ones ingest assigns.
 *
 * @param {import('./observe-db.mjs').Db} db
 * @param {object} cfg
 * @param {{ limit?: number }} [opts]
 * @returns {{ scanned: number, labels: number, prompts: number, remaining: number }}
 */
export function backfillMcpCalls(db, cfg, opts = {}) {
    const limit = opts.limit ?? 20;
    const convs = db.all(
        `SELECT id, transcript_path FROM conversation
         WHERE transcript_path IS NOT NULL AND transcript_path != ''
           AND id NOT IN (
               SELECT conversation_id FROM mcp_prompt_backfill WHERE step_version >= ?
           )
         ORDER BY updated_at DESC
         LIMIT ?`,
        [MCP_BACKFILL_VERSION, limit],
    );
    const remainingRow = db.get(
        `SELECT COUNT(*) AS n FROM conversation
         WHERE transcript_path IS NOT NULL AND transcript_path != ''
           AND id NOT IN (
               SELECT conversation_id FROM mcp_prompt_backfill WHERE step_version >= ?
           )`,
        [MCP_BACKFILL_VERSION],
    );

    let prompts = 0;
    let labels = 0;
    for (const conv of convs) {
        const filePath = path.isAbsolute(conv.transcript_path)
            ? conv.transcript_path
            : path.join(cfg.root, conv.transcript_path);
        let size = 0;
        try {
            const buf = fs.readFileSync(filePath);
            size = buf.byteLength;
            /*
             * Drop prompt rows written under an older hash rule. Leaving them would keep wrong
             * `prompt_sha256` values that never join the ledger, while the new inserts use a
             * different id (conversation + new sha) and cannot overwrite them.
             */
            db.run('DELETE FROM mcp_prompt WHERE conversation_id = ? AND project_id = ?', [
                conv.id,
                cfg.project.id,
            ]);
            for (const row of parseTranscriptCalls(buf)) {
                const llmCallId = `${conv.id}:${row.boundaryIndex}:${row.callIndex}`;
                // Only touch rows whose stored label differs, so a re-walk is not a mass rewrite.
                const changed = db.run(
                    `UPDATE llm_call SET tool_names = ?, tool_count = ?
                     WHERE id = ? AND (tool_names IS NOT ? OR tool_count IS NOT ?)`,
                    [row.toolNames, row.tools, llmCallId, row.toolNames, row.tools],
                );
                labels += Number(changed?.changes ?? 0);
                for (const { tool, prompt } of row.mcpPrompts ?? []) {
                    insertPromptRow(db, {
                        projectId: cfg.project.id,
                        conversationId: conv.id,
                        requestId: `${conv.id}:${row.boundaryIndex}`,
                        llmCallId,
                        tool,
                        prompt,
                    });
                    prompts += 1;
                }
            }
        } catch {
            // A transcript that has been deleted is not a failure; mark it done so it stops being
            // retried on every cycle.
        }
        db.run(
            `INSERT INTO mcp_prompt_backfill (conversation_id, byte_size, step_version, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 byte_size = excluded.byte_size,
                 step_version = excluded.step_version,
                 updated_at = excluded.updated_at`,
            [conv.id, size, MCP_BACKFILL_VERSION, isoNow()],
        );
    }

    return {
        scanned: convs.length,
        labels,
        prompts,
        remaining: Math.max(0, (remainingRow?.n ?? 0) - convs.length),
    };
}

/**
 * Read the provider's usage ledger and attribute each record to the request that sent its prompt.
 *
 * @param {import('./observe-db.mjs').Db} db
 * @param {object} cfg
 * @param {{ ledgerPath?: string }} [opts]
 * @returns {{
 *   read: number, inserted: number, attributed: number, unattributed: number,
 *   skipped: number, reattributed: number,
 * }}
 */
export function ingestMcpUsage(db, cfg, opts = {}) {
    const ledgerPath = opts.ledgerPath || defaultUsageLedgerPath();
    const records = readUsageLedger(ledgerPath);
    const empty = {
        read: records.length,
        inserted: 0,
        attributed: 0,
        unattributed: 0,
        skipped: 0,
        reattributed: 0,
    };
    if (!records.length) return empty;

    /** @type {Map<string, string | null>} */
    const known = new Map(
        db
            .all('SELECT id, request_id FROM mcp_call WHERE project_id = ?', [cfg.project.id])
            .map((r) => [r.id, r.request_id ?? null]),
    );

    let inserted = 0;
    let attributed = 0;
    let unattributed = 0;
    let skipped = 0;
    let reattributed = 0;

    for (const record of records) {
        const sha = typeof record.promptSha256 === 'string' ? record.promptSha256 : '';
        if (!sha) continue;

        const id = recordId(cfg.project.id, record);

        /*
         * Prompt hashes are project-scoped: two projects can legitimately send the same prompt, and
         * the same text must not be attributed to whichever row happened to be read first.
         */
        const owner = db.get(
            'SELECT request_id, conversation_id, tool FROM mcp_prompt WHERE project_id = ? AND prompt_sha256 = ? LIMIT 1',
            [cfg.project.id, sha],
        );

        if (known.has(id)) {
            /*
             * Rows inserted before the hash rule matched stay with null request_id forever under
             * `ON CONFLICT DO NOTHING`. Once mcp_prompt catches up, stamp ownership in place.
             */
            if (known.get(id) == null && owner?.request_id) {
                db.run(
                    `UPDATE mcp_call
                     SET request_id = ?, conversation_id = ?, tool = ?
                     WHERE id = ? AND project_id = ? AND request_id IS NULL`,
                    [
                        owner.request_id,
                        owner.conversation_id ?? null,
                        toolLabelForLedgerRecord(record, owner.tool),
                        id,
                        cfg.project.id,
                    ],
                );
                known.set(id, owner.request_id);
                reattributed += 1;
                attributed += 1;
            } else {
                skipped += 1;
            }
            continue;
        }

        const usage = record.usage || {};
        db.run(
            `INSERT INTO mcp_call (
                id, project_id, request_id, conversation_id, tool, model, prompt_sha256, prompt_chars,
                prompt_tokens, completion_tokens, total_tokens, cache_hit_tokens, cache_miss_tokens,
                reasoning_tokens, elapsed_ms, aborted, http_status, at, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
            [
                id,
                cfg.project.id,
                owner?.request_id ?? null,
                owner?.conversation_id ?? null,
                toolLabelForLedgerRecord(record, owner?.tool),
                record.model ?? null,
                sha,
                numOrNull(record.promptChars),
                numOrNull(usage.prompt_tokens),
                numOrNull(usage.completion_tokens),
                numOrNull(usage.total_tokens),
                numOrNull(usage.prompt_cache_hit_tokens),
                numOrNull(usage.prompt_cache_miss_tokens),
                numOrNull(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
                numOrNull(record.elapsedMs),
                record.aborted === true ? 1 : 0,
                numOrNull(record.httpStatus),
                record.at ?? '',
                'deepseek-ledger',
            ],
        );
        known.set(id, owner?.request_id ?? null);
        inserted += 1;
        if (owner?.request_id) attributed += 1;
        else unattributed += 1;
    }

    return { ...empty, inserted, attributed, unattributed, skipped, reattributed };
}
