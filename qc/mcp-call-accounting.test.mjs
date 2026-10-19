import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeIngestDb, runIngestOnce } from '../packages/harness-observe-server/src/ingest.mjs';
import {
    assistantStats,
    mcpPromptOf,
    mcpToolLabel,
} from '../packages/harness-observe-server/src/ingest-transcript.mjs';
import {
    classifyMcpToolName,
    mcpCountsFromToolNames,
} from '../packages/harness-observe-server/src/parse-transcript-calls.mjs';
import { ingestMcpUsage, defaultUsageLedgerPath } from '../packages/harness-observe-server/src/ingest-mcp-usage.mjs';
import { usageHashPrompt } from '../packages/harness-observe-server/src/mcp-prompt-store.mjs';

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
/** Ledger hash = MCP server hash = stripped Brain/route body, not the raw transcript argument. */
const ledgerSha = (prompt) => sha(usageHashPrompt(prompt));

/** Cursor routes every MCP call through this one generic tool. */
const wrap = (toolName, prompt) => ({
    type: 'tool_use',
    name: 'CallDynamicTool',
    input: { namespace: 'project-0-x79-deepseek-direct', toolName, arguments: prompt === undefined ? {} : { prompt } },
});

/**
 * F31 — the counting half.
 *
 * The wrapper name told us nothing: 339 brain calls in one conversation were recorded as
 * `CallDynamicTool`, so `mcp_call_stats` reported zero Brain and zero Pro for every Cursor turn. The
 * real tool is in the input, and for `ask_deepseek_flash` the *tier* is in a prompt prefix that the
 * MCP server itself reads.
 */
test('a wrapper call is recorded as the tool it actually invoked', () => {
    assert.equal(mcpToolLabel('Read', { path: 'x' }), 'Read');
    assert.equal(mcpToolLabel('CallDynamicTool', { toolName: 'getJiraIssue' }), 'mcp:getJiraIssue');
    assert.equal(mcpToolLabel('CallDynamicTool', {}), 'CallDynamicTool');
});

test('the flash tier is read from the prompt prefix, not guessed from the name', () => {
    // Measured on this machine: 248 of 588 `ask_deepseek_flash` calls are Brain. Guessing from the
    // name would mislabel most of them.
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek_flash', '[BRAIN FLASH] x').input), 'mcp:ask_deepseek_flash_brain');
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek_flash', '[BRAIN FALLBACK] x').input), 'mcp:ask_deepseek_flash_brain_fallback');
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek_flash', 'plain task').input), 'mcp:ask_deepseek_flash');
    // `[BRAIN OUTPUT]` is the dispatcher applying Brain output — executor work, per the server's
    // own `classifyPrompt`.
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek_flash', '[BRAIN OUTPUT] x').input), 'mcp:ask_deepseek_flash');
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek_pro', 'x').input), 'mcp:ask_deepseek_pro');
});

test('the smart router is not guessed into a tier', () => {
    // Its tier depends on complexity keywords evaluated at call time; re-deriving them here would be
    // a second source of truth for routing.
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek', 'no override').input), 'mcp:ask_deepseek_auto');
    // An explicit override is deterministic, so it is honoured.
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek', '[pro] x').input), 'mcp:ask_deepseek_pro');
    assert.equal(mcpToolLabel('CallDynamicTool', wrap('ask_deepseek', '[flash] x').input), 'mcp:ask_deepseek_flash');
});

test('classification matches the consumer vocabulary', () => {
    assert.equal(classifyMcpToolName('mcp:ask_deepseek_pro'), 'pro');
    assert.equal(classifyMcpToolName('mcp:ask_deepseek_flash_brain'), 'flash_brain');
    assert.equal(classifyMcpToolName('mcp:ask_deepseek_flash_brain_fallback'), 'flash_brain');
    // A bare `ask_deepseek_flash` is the executor. This used to classify as Brain, so every
    // executor call was reported as a paid reasoning call.
    assert.equal(classifyMcpToolName('mcp:ask_deepseek_flash'), 'flash_executor');
    assert.equal(classifyMcpToolName('mcp:ask_deepseek_auto'), 'smart');
    assert.equal(classifyMcpToolName('CallDynamicTool'), null);
    assert.equal(classifyMcpToolName('mcp:getJiraIssue'), null);
    assert.equal(classifyMcpToolName(''), null);
});

test('counts aggregate per label and keep the smart bucket separate', () => {
    const counts = mcpCountsFromToolNames(
        'Read,mcp:ask_deepseek_flash_brain,mcp:ask_deepseek_flash,mcp:ask_deepseek_pro,mcp:ask_deepseek_auto,mcp:getJiraIssue',
    );
    assert.equal(counts.flash_brain_count, 1);
    assert.equal(counts.flash_executor_count, 1);
    assert.equal(counts.pro_count, 1);
    assert.equal(counts.smart_route_count, 1);
    assert.equal(counts.jev_count, 0);
});

test('assistantStats surfaces model prompts for hashing', () => {
    const st = assistantStats({
        content: [wrap('ask_deepseek_flash', '[BRAIN FLASH] do the thing'), { type: 'text', text: 'hi' }],
    });
    assert.deepEqual(st.names, ['mcp:ask_deepseek_flash_brain']);
    assert.equal(st.mcpPrompts.length, 1);
    assert.equal(st.mcpPrompts[0].tool, 'mcp:ask_deepseek_flash_brain');
    assert.equal(st.mcpPrompts[0].prompt, '[BRAIN FLASH] do the thing');

    // Non-model MCP calls have no prompt to hash and no tokens to attribute.
    assert.equal(mcpPromptOf('CallDynamicTool', { toolName: 'getJiraIssue', arguments: { issueIdOrKey: 'X' } }), null);
    assert.equal(mcpPromptOf('Read', { path: 'x' }), null);
});

// ---------------------------------------------------------------------------
// F32 — the token half, end to end
// ---------------------------------------------------------------------------

const USER_LINE = JSON.stringify({
    role: 'user',
    message: {
        content: [
            {
                type: 'text',
                text: '<timestamp>Mon Jan 1 2026</timestamp><user_query>review the ticket</user_query>',
            },
        ],
    },
});

const PROMPT = '[BRAIN FLASH]  [USER REQUEST] review the ticket';
const PROMPT_BODY = usageHashPrompt(PROMPT);

test('usageHashPrompt mirrors the DeepSeek MCP strip before ledger hash', () => {
    assert.equal(usageHashPrompt('[BRAIN FLASH]\n\nbody'), 'body');
    assert.equal(usageHashPrompt('[BRAIN FALLBACK] body'), 'body');
    assert.equal(usageHashPrompt('[pro] force pro'), 'force pro');
    assert.equal(usageHashPrompt('[flash] force flash'), 'force flash');
    assert.equal(usageHashPrompt('plain executor'), 'plain executor');
    // Classification still sees the raw prefix; hashing must not.
    assert.notEqual(PROMPT_BODY, PROMPT);
    assert.equal(PROMPT_BODY, '[USER REQUEST] review the ticket');
});

/**
 * @param {{
 *   projectId?: string,
 *   withPrompt?: boolean,
 *   productStateDir?: string,
 * }} [opts]
 */
function fixture(opts = {}) {
    const { projectId = 'mcp-usage-qc', withPrompt = true } = opts;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-usage-'));
    const transcriptDir = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, 'conv.jsonl');
    fs.writeFileSync(
        transcript,
        [
            USER_LINE,
            JSON.stringify({
                role: 'assistant',
                // `withPrompt: false` models a project whose turns made no model MCP call, which is
                // the case that used to lose another project's spend.
                message: { content: [wrap('ask_deepseek_flash', withPrompt ? PROMPT : 'plain executor task')] },
            }),
            JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
            '',
        ].join('\n'),
    );
    const dbPath = path.join(root, '.harness', 'harness.db');
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'harness.config.json'),
        JSON.stringify({
            project: { id: projectId, displayName: projectId },
            ingest: { transcriptDir },
            storage: { driver: 'sqlite', sqlite: { path: dbPath } },
        }),
    );
    fs.writeFileSync(
        path.join(root, '.harness', 'decision-policy.json'),
        JSON.stringify({
            version: 1,
            jev: { mode: 'off' },
            ledger: { enabled: false },
            eso: { enabled: false },
        }),
    );
    // The ledger lands in product state, so the fixture has to own that path too — otherwise the
    // default resolution would read the operator's real `~/.harness` ledger.
    const previousProductState = process.env.HARNESS_PRODUCT_STATE_DIR;
    const previousLedger = process.env.DEEPSEEK_USAGE_LEDGER;
    const productStateDir = opts.productStateDir ?? path.join(root, '.harness');
    process.env.HARNESS_PRODUCT_STATE_DIR = productStateDir;
    delete process.env.DEEPSEEK_USAGE_LEDGER;
    const restoreEnv = () => {
        if (previousProductState === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = previousProductState;
        if (previousLedger === undefined) delete process.env.DEEPSEEK_USAGE_LEDGER;
        else process.env.DEEPSEEK_USAGE_LEDGER = previousLedger;
    };
    return {
        root,
        transcript,
        ledger: path.join(productStateDir, 'deepseek-usage.jsonl'),
        restoreEnv,
        cfg: {
            ok: true,
            root,
            configPath: path.join(root, 'harness.config.json'),
            dataDir: path.join(root, '.harness'),
            project: { id: projectId, displayName: projectId },
            enabled: true,
            sentinelPath: path.join(root, '.harness', 'DISABLED'),
            storage: { driver: 'sqlite', target: dbPath, remoteUrl: null },
            server: { host: '127.0.0.1', port: 8792 },
            ingest: { pollMs: 2000, transcriptDir, hookFiles: [] },
            decisionPolicyPath: path.join(root, '.harness', 'decision-policy.json'),
        },
    };
}

const ledgerLine = (overrides = {}) =>
    `${JSON.stringify({
        ledger: 1,
        at: '2026-01-01T00:00:00.000Z',
        role: 'brain_flash',
        // Same body the MCP server hashes after stripping `[BRAIN FLASH]`.
        promptSha256: ledgerSha(PROMPT),
        promptChars: PROMPT_BODY.length,
        model: 'deepseek-flash',
        usage: {
            prompt_tokens: 4242,
            completion_tokens: 777,
            total_tokens: 5019,
            prompt_cache_hit_tokens: 4000,
            prompt_cache_miss_tokens: 242,
        },
        httpStatus: 200,
        attempt: 1,
        aborted: false,
        outcome: 'ok',
        elapsedMs: 1234,
        ...overrides,
    })}\n`;

test('a ledger record is attributed to the request that sent its prompt', async () => {
    const { cfg, ledger, restoreEnv } = fixture();
    fs.writeFileSync(ledger, ledgerLine());
    try {
        const report = await runIngestOnce(cfg);
        assert.equal(report.ok, true);
        assert.equal(report.mcpUsage.inserted, 1);
        assert.equal(report.mcpUsage.attributed, 1);
        assert.equal(report.mcpUsage.unattributed, 0);

        // The prompt was recorded against the turn during the transcript pass.
        const { openDb } = await import('../packages/harness-observe-server/src/observe-db.mjs');
        const db = openDb(cfg.storage.target);
        const prompt = db.get('SELECT * FROM mcp_prompt WHERE prompt_sha256 = ?', [ledgerSha(PROMPT)]);
        assert.ok(prompt, 'mcp_prompt must hash the stripped body the ledger uses');
        assert.equal(prompt.tool, 'mcp:ask_deepseek_flash_brain');
        assert.equal(Number(prompt.prompt_chars), PROMPT_BODY.length);
        // Raw transcript hash must NOT be the join key — that was the Brain-token blind spot.
        assert.equal(
            db.get('SELECT * FROM mcp_prompt WHERE prompt_sha256 = ?', [sha(PROMPT)]) ?? null,
            null,
        );

        const call = db.get('SELECT * FROM mcp_call WHERE prompt_sha256 = ?', [ledgerSha(PROMPT)]);
        assert.equal(call.request_id, prompt.request_id, 'usage must land on that request');
        assert.equal(call.prompt_tokens, 4242);
        assert.equal(call.completion_tokens, 777);
        assert.equal(call.cache_hit_tokens, 4000);
        assert.equal(call.model, 'deepseek-flash');

        // And the per-request summary the UI reads carries it.
        const stats = db.get('SELECT * FROM mcp_call_stats WHERE request_id = ?', [prompt.request_id]);
        assert.equal(stats.flash_brain_count, 1, 'the wrapper must be counted as a brain call');
        assert.equal(stats.smart_route_count, 0);
        assert.equal(stats.brain_prompt_tokens, 4242);
        assert.equal(stats.brain_completion_tokens, 777);
        assert.equal(stats.brain_cache_hit_tokens, 4000);
        assert.equal(stats.brain_usage_calls, 1);
        db.close();
    } finally {
        restoreEnv();
        closeIngestDb();
    }
});

test('re-running ingest does not double-count the ledger', async () => {
    const { cfg, ledger, restoreEnv } = fixture();
    fs.writeFileSync(ledger, ledgerLine());
    try {
        await runIngestOnce(cfg);
        const second = await runIngestOnce(cfg);
        assert.equal(second.mcpUsage.inserted, 0, 'the same record must not be inserted twice');

        const { openDb } = await import('../packages/harness-observe-server/src/observe-db.mjs');
        const db = openDb(cfg.storage.target);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM mcp_call').n, 1);
        const stats = db.get('SELECT brain_prompt_tokens FROM mcp_call_stats');
        assert.equal(stats.brain_prompt_tokens, 4242, 'totals must not accumulate across cycles');
        db.close();
    } finally {
        restoreEnv();
        closeIngestDb();
    }
});

test('a previously unattributed ledger row is stamped once the prompt hash matches', async () => {
    /*
     * Before usageHashPrompt, Brain ledger lines landed with null request_id and stayed that way
     * under ON CONFLICT DO NOTHING. After mcp_prompt catches up under the ledger hash, the next
     * ingest must UPDATE ownership in place — otherwise historical Brain spend stays invisible.
     */
    const { cfg, ledger, restoreEnv } = fixture();
    fs.writeFileSync(ledger, ledgerLine());
    const { openDb, migrate } = await import('../packages/harness-observe-server/src/observe-db.mjs');
    try {
        const prep = openDb(cfg.storage.target);
        migrate(prep);
        const orphan = ingestMcpUsage(prep, cfg, { ledgerPath: ledger });
        assert.equal(orphan.inserted, 1);
        assert.equal(orphan.unattributed, 1);
        assert.equal(prep.get('SELECT request_id FROM mcp_call').request_id, null);
        prep.close();

        // Transcript write + correct prompt hash; ledger line already present as an orphan.
        const report = await runIngestOnce(cfg);
        assert.equal(report.mcpUsage.reattributed, 1);

        const db = openDb(cfg.storage.target);
        const call = db.get('SELECT request_id, prompt_tokens FROM mcp_call');
        assert.ok(call.request_id, 'orphan must be stamped onto the request that sent the prompt');
        assert.equal(call.prompt_tokens, 4242);
        assert.equal(
            db.get('SELECT brain_usage_calls FROM mcp_call_stats WHERE request_id = ?', [call.request_id])
                ?.brain_usage_calls,
            1,
        );
        db.close();
    } finally {
        restoreEnv();
        closeIngestDb();
    }
});

test('an unattributable record is kept, not dropped', async () => {
    /*
     * Spend the observer cannot place is still evidence that spend happened. Dropping it would
     * recreate the original blind spot in a quieter form — the totals would simply be too low with
     * nothing to explain why.
     */
    const { cfg, ledger, restoreEnv } = fixture();
    fs.writeFileSync(ledger, ledgerLine({ promptSha256: sha('a prompt no transcript contains') }));

    const { openDb, migrate } = await import('../packages/harness-observe-server/src/observe-db.mjs');
    const db = openDb(cfg.storage.target);
    try {
        migrate(db);
        const out = ingestMcpUsage(db, cfg, { ledgerPath: ledger });
        assert.equal(out.inserted, 1);
        assert.equal(out.attributed, 0);
        assert.equal(out.unattributed, 1);

        const row = db.get('SELECT * FROM mcp_call');
        assert.equal(row.request_id, null, 'kept, but explicitly unattributed');
        assert.equal(row.prompt_tokens, 4242);
    } finally {
        db.close();
        restoreEnv();
        closeIngestDb();
    }
});

test('a missing ledger is not an error', async () => {
    const { cfg, restoreEnv } = fixture();
    try {
        const report = await runIngestOnce(cfg);
        assert.equal(report.ok, true);
        assert.equal(report.mcpUsage.read, 0);
        assert.equal(report.mcpUsage.inserted, 0);
    } finally {
        restoreEnv();
        closeIngestDb();
    }
});

test('the ledger path agrees between a host MCP server and a container reader', async () => {
    /*
     * The ledger is the one artifact both sides must name identically, and they run in different
     * filesystems. An earlier version put it under HARNESS_DATA_ROOT — the same directory on the
     * host, which is why local development looked correct, but a **named volume** in Docker, a
     * container-only filesystem the host MCP server cannot see. Nothing was ever attributed in a
     * container.
     *
     * Product state is the correct home because it is true state: compose bind-mounts the operator's
     * `~/.harness` to `/data/product-state`, so one rule resolves correctly in both places.
     */
    const previous = process.env.HARNESS_PRODUCT_STATE_DIR;
    const previousOverride = process.env.DEEPSEEK_USAGE_LEDGER;
    try {
        delete process.env.DEEPSEEK_USAGE_LEDGER;
        process.env.HARNESS_PRODUCT_STATE_DIR = '/data/product-state';
        assert.equal(
            defaultUsageLedgerPath(),
            '/data/product-state/deepseek-usage.jsonl',
            'in the container the ledger must land on the bind-mounted product state',
        );

        delete process.env.HARNESS_PRODUCT_STATE_DIR;
        assert.equal(
            defaultUsageLedgerPath(),
            path.join(os.homedir(), '.harness', 'deepseek-usage.jsonl'),
            'on the host it must land where the MCP server writes',
        );

        // An explicit override must win on both sides, since the MCP server cannot import this rule.
        process.env.DEEPSEEK_USAGE_LEDGER = '/shared/ledger.jsonl';
        assert.equal(defaultUsageLedgerPath(), '/shared/ledger.jsonl');
    } finally {
        if (previous === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = previous;
        if (previousOverride === undefined) delete process.env.DEEPSEEK_USAGE_LEDGER;
        else process.env.DEEPSEEK_USAGE_LEDGER = previousOverride;
    }
});

test('two projects reading one machine-wide ledger each keep their own row', async () => {
    /*
     * The ledger is machine-wide — one file, written by one MCP server that knows nothing about
     * projects — while *every* project reads the whole thing. So the id of a record must not be a
     * function of the record alone: two projects would compute the same id, and
     * `ON CONFLICT(id) DO NOTHING` let the first one keep the row. The owning project then inserted
     * nothing (reported as `skipped`) and lost its spend, while the other showed it as unattributed.
     *
     * Both projects share one product state here, so the ledger is reached through the default
     * resolution and every assertion travels the production path: one ingest pass reads the
     * transcript, attributes the ledger, and refreshes the totals.
     */
    const sharedState = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shared-state-'));
    const owner = fixture({ projectId: 'proj-owner', productStateDir: sharedState });
    // No model call in this project's transcript, so it owns none of the ledger's prompts.
    const other = fixture({ projectId: 'proj-other', withPrompt: false, productStateDir: sharedState });
    fs.writeFileSync(owner.ledger, ledgerLine());
    assert.equal(owner.ledger, other.ledger, 'both projects must be reading the same file');

    try {
        // The owning project ingests first, exactly as the bug required.
        await runIngestOnce(owner.cfg);
        await runIngestOnce(other.cfg);

        const { openDb } = await import('../packages/harness-observe-server/src/observe-db.mjs');
        const ownerDb = openDb(owner.cfg.storage.target);
        const otherDb = openDb(other.cfg.storage.target);

        const ownerRow = ownerDb.get('SELECT id, request_id FROM mcp_call');
        const otherRow = otherDb.get('SELECT id, request_id FROM mcp_call');
        assert.ok(ownerRow, 'the owner must have recorded the spend');
        assert.ok(
            otherRow,
            'the second project must still record the spend rather than report it as already present',
        );
        assert.ok(ownerRow.request_id, 'attributed for the project that sent the prompt');
        assert.equal(otherRow.request_id, null, 'kept but explicitly unattributed for the other');

        // Distinct ids: this is what stops the second project's insert from colliding.
        assert.notEqual(ownerRow.id, otherRow.id);

        // The owner's totals carry the spend; the other project's must not absorb it.
        assert.equal(ownerDb.get('SELECT brain_prompt_tokens FROM mcp_call_stats')?.brain_prompt_tokens, 4242);
        assert.equal(
            otherDb.get('SELECT brain_prompt_tokens FROM mcp_call_stats')?.brain_prompt_tokens ?? null,
            null,
            'an unattributed call must not appear in any project totals',
        );

        // Re-running either project stays idempotent under the scoped id.
        await runIngestOnce(owner.cfg);
        await runIngestOnce(other.cfg);
        assert.equal(ownerDb.get('SELECT COUNT(*) AS n FROM mcp_call').n, 1);
        assert.equal(otherDb.get('SELECT COUNT(*) AS n FROM mcp_call').n, 1);
        assert.equal(ownerDb.get('SELECT brain_prompt_tokens FROM mcp_call_stats')?.brain_prompt_tokens, 4242);

        ownerDb.close();
        otherDb.close();
    } finally {
        owner.restoreEnv();
        other.restoreEnv();
        closeIngestDb();
    }
});

test('history backfills prompts that live ingest already passed by', async () => {
    /*
     * Live ingest only reads new bytes. A transcript fully ingested before this feature existed
     * yields no prompt rows, and with no prompt rows the provider's usage can never be attributed —
     * which would leave the exact spend this feature exists to expose permanently invisible for
     * everything already on disk.
     */
    const { cfg, ledger, restoreEnv } = fixture();
    fs.writeFileSync(ledger, ledgerLine());
    try {
        // Simulate history: the transcript is already ingested, so live ingest has nothing to read.
        const first = await runIngestOnce(cfg);
        assert.equal(first.ok, true);

        const { openDb } = await import('../packages/harness-observe-server/src/observe-db.mjs');
        const { backfillMcpCalls, ingestMcpUsage } = await import(
            '../packages/harness-observe-server/src/ingest-mcp-usage.mjs'
        );
        const db = openDb(cfg.storage.target);

        // Wipe what live ingest captured, as if it had never run against this file, and restore the
        // legacy stored label — before this feature every MCP call was stored as the wrapper name.
        db.run('DELETE FROM mcp_prompt');
        db.run('DELETE FROM mcp_prompt_backfill');
        db.run('DELETE FROM mcp_call');
        db.run("UPDATE llm_call SET tool_names = 'CallDynamicTool' WHERE tool_names LIKE 'mcp:%'");
        assert.equal(
            db.get('SELECT tool_names FROM llm_call WHERE tool_names IS NOT NULL LIMIT 1').tool_names,
            'CallDynamicTool',
            'the fixture must start from the pre-feature state',
        );

        const out = backfillMcpCalls(db, cfg, { limit: 5 });
        assert.equal(out.prompts, 1, 'the walk must recover the prompt from history');
        assert.equal(out.labels, 1, 'and re-resolve the wrapper name to the real tool');
        assert.equal(
            db.get('SELECT tool_names FROM llm_call WHERE tool_names IS NOT NULL LIMIT 1').tool_names,
            'mcp:ask_deepseek_flash_brain',
            'history must stop reporting every MCP call as CallDynamicTool',
        );

        const prompt = db.get('SELECT * FROM mcp_prompt WHERE prompt_sha256 = ?', [ledgerSha(PROMPT)]);
        assert.ok(prompt, 'backfill must record the prompt under the ledger hash');
        assert.equal(prompt.tool, 'mcp:ask_deepseek_flash_brain');
        // The derived request id must match the one ingest assigns: `<conversation>:<boundary>`.
        assert.match(prompt.request_id, /^conv:1$/);

        // And the ledger now attributes to that recovered request.
        const usage = ingestMcpUsage(db, cfg, { ledgerPath: ledger });
        assert.equal(usage.attributed, 1);
        const call = db.get('SELECT request_id, prompt_tokens FROM mcp_call');
        assert.equal(call.request_id, prompt.request_id);
        assert.equal(call.prompt_tokens, 4242);

        // A second backfill pass must not repeat the walk.
        assert.equal(backfillMcpCalls(db, cfg, { limit: 5 }).scanned, 0);
        db.close();
    } finally {
        restoreEnv();
        closeIngestDb();
    }
});
