import { loadDecisionFlowForRequest } from './decision-flow.mjs';
import { buildEsoDesignGraph } from './eso-design-view.mjs';
import { loadEvidenceForRequest } from './eso-view.mjs';
import {
    synthesizePostToolEventsFromLlmCalls,
    tokenSummaryForRequest,
    toolsSummaryFromLlmCalls,
} from './ag-request-enrich.mjs';
import { buildConsentVm } from './observe-consent-vm.mjs';
import { buildPromaxFlowGraph } from './flow-graph-build.mjs';
import { enrichRequestEvents, loadAttachedForRequest } from './request-flow-evidence.mjs';

export function callKindSql(t) {
    return `CASE
            WHEN ${t}.tool_count = 0 AND ${t}.call_index = (SELECT MAX(c2.call_index) FROM llm_call c2 WHERE c2.request_id = ${t}.request_id) THEN 'answer'
            WHEN ${t}.tool_count = 1 THEN 'single'
            ELSE 'batched'
        END`;
}

export function requestDetail(db, cfg, id) {
    const request = db.get('SELECT * FROM request WHERE id = ? AND project_id = ?', [id, cfg.project.id]);
    if (!request) return null;

    const evidenceRaw = loadEvidenceForRequest(db, cfg.project.id, id);
    const esoDesignGraph = evidenceRaw.summary?.level
        ? buildEsoDesignGraph(evidenceRaw.summary.level, evidenceRaw.bundle)
        : null;

    const llmCalls = db.all(
        `SELECT id, call_index AS callIndex, file_line_no AS fileLineNo, tool_count AS toolCount,
                text_chars AS textChars, emit_chars AS emitChars,
                ROUND(emit_chars / 4.0) AS estTokens,
                tool_names AS toolNames, preview,
                ${callKindSql('llm_call')} AS kind
         FROM llm_call WHERE request_id = ? ORDER BY call_index`,
        [id],
    );

    const genId = request.generation_id || request.id;
    let stops = db.all(
        `SELECT harness, model_id AS modelId, status, input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_read AS cacheRead, cache_write AS cacheWrite, hook_at AS hookAt
         FROM request_stop
         WHERE project_id = ? AND (request_id = ? OR generation_id = ?)
         ORDER BY CASE harness WHEN 'agents' THEN 0 ELSE 1 END, hook_at DESC`,
        [cfg.project.id, id, genId],
    );

    if (!stops.length && request.conversation_id && request.started_at) {
        stops = db.all(
            `SELECT harness, model_id AS modelId, status, input_tokens AS inputTokens, output_tokens AS outputTokens,
                    cache_read AS cacheRead, cache_write AS cacheWrite, hook_at AS hookAt
             FROM request_stop
             WHERE project_id = ? AND conversation_id = ? AND request_id IS NULL
               AND replace(hook_at, 'Z', '') >= replace(?, 'Z', '')
               AND replace(hook_at, 'Z', '') <= replace(COALESCE(?, ?, hook_at), 'Z', '')
             ORDER BY hook_at DESC LIMIT 12`,
            [cfg.project.id, request.conversation_id, request.started_at, request.ended_at, request.started_at],
        );
    }

    let events = enrichRequestEvents(
        db.all(
            `SELECT harness, event_type AS eventType, tool, path, hook_at AS hookAt,
                    json_extract(raw_json, '$.payload.tool_input.command') AS command,
                    raw_json
             FROM event WHERE request_id = ? ORDER BY hook_at, id LIMIT 400`,
            [id],
        ),
        cfg.root,
    );

    let evidenceNote = null;
    if (!events.length && llmCalls.length) {
        events = synthesizePostToolEventsFromLlmCalls(llmCalls, cfg.root);
        evidenceNote =
            'Tool list from transcript (hook trace not linked — check hooks + route-hook.py).';
    }

    const consentSlice = buildConsentVm(cfg, evidenceRaw);
    const mcpCallStats = mcpCallStatsForRequest(db, id);
    const attached = loadAttachedForRequest(db, cfg.project.id, request);
    if (!attached.length && events.some((e) => e.eventType === 'postToolUse')) {
        evidenceNote = [
            evidenceNote,
            'Rules/skills at prompt: add route-hook on beforeSubmitPrompt (profiles/host/cursor-superset) so attachments land in route-trace.',
        ]
            .filter(Boolean)
            .join(' ');
    }
    const tools = (() => {
        const rows = db.all(
            'SELECT tool, count FROM request_tool WHERE request_id = ? ORDER BY count DESC',
            [id],
        );
        return rows.length ? rows : toolsSummaryFromLlmCalls(llmCalls);
    })();
    const rules = db.all(
        'SELECT rule_id AS ruleId, attached_at AS attachedAt FROM request_rule WHERE request_id = ?',
        [id],
    );
    const files = db.all(
        'SELECT path, actions, reads, edits FROM request_file WHERE request_id = ? ORDER BY edits DESC, reads DESC',
        [id],
    );
    const decisionFlow = loadDecisionFlowForRequest(db, cfg.project.id, id, {
        events,
        tools,
        files,
        attached,
    });

    return {
        request,
        tenantRootPath: cfg.root,
        requestMetrics: requestHeaderMetrics(request, mcpCallStats, tools),
        mcpCallStats,
        decisionFlow,
        evidence: {
            ...evidenceRaw.summary,
            bundle: evidenceRaw.bundle,
            designGraph: esoDesignGraph,
        },
        ...consentSlice,
        conversation: db.get('SELECT * FROM conversation WHERE id = ?', [request.conversation_id]) || null,
        llmCalls,
        checks: db.all(
            'SELECT check_id AS checkId, status, heuristic, detail FROM check_result WHERE request_id = ?',
            [id],
        ),
        rules,
        attached,
        files,
        tools,
        stops,
        events,
        evidenceNote,
        tokenSummary: tokenSummaryForRequest(request, llmCalls, stops),
        flowGraph: buildPromaxFlowGraph({
            userQuery: request.user_query,
            attached,
            rules,
            events,
            rootPath: cfg.root,
        }),
    };
}

export function listCalls(db, cfg, url) {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number.parseInt(p.get('limit') || '500', 10) || 500, 1), 2000);
    const offset = Math.max(Number.parseInt(p.get('offset') || '0', 10) || 0, 0);
    const kind = callKindSql('c');

    const where = ['r.project_id = ?'];
    const params = [cfg.project.id];
    if (p.get('conversationId')) {
        where.push('r.conversation_id = ?');
        params.push(p.get('conversationId'));
    }
    if (p.get('requestId')) {
        where.push('c.request_id = ?');
        params.push(p.get('requestId'));
    }
    const clause = where.join(' AND ');
    const base = `FROM llm_call c JOIN request r ON r.id = c.request_id WHERE ${clause}`;
    const want = p.get('kind');
    const kindOk = want === 'single' || want === 'batched' || want === 'answer';
    const kindFilter = kindOk ? ` AND ${kind} = ?` : '';
    const kindParams = kindOk ? [want] : [];

    return {
        items: db.all(
            `SELECT c.id, c.request_id AS requestId, r.conversation_id AS conversationId,
                    r.boundary_index AS boundaryIndex, c.call_index AS callIndex,
                    c.tool_count AS toolCount, c.tool_names AS toolNames,
                    c.text_chars AS textChars, c.emit_chars AS emitChars,
                    ROUND(c.emit_chars / 4.0) AS estTokens, c.preview,
                    r.started_at AS requestStartedAt, r.user_query AS userQuery,
                    ${kind} AS kind
             ${base}${kindFilter}
             ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.boundary_index DESC, c.call_index ASC
             LIMIT ? OFFSET ?`,
            [...params, ...kindParams, limit, offset],
        ),
        summary: db.get(
            `SELECT COUNT(*) AS calls, SUM(${kind} = 'single') AS single,
                    SUM(${kind} = 'batched') AS batched, SUM(${kind} = 'answer') AS answer
             ${base}`,
            params,
        ),
        page: {
            limit,
            offset,
            total: db.get(`SELECT COUNT(*) AS n ${base}${kindFilter}`, [...params, ...kindParams]).n,
        },
    };
}

function mcpCallStatsForRequest(db, requestId) {
    const row = db.get(
        `SELECT flash_brain_count AS flashBrain, flash_executor_count AS flashExecutor,
                pro_count AS proCount, smart_route_count AS smartRouteCount, jev_count AS jevCount,
                brain_prompt_tokens AS brainPromptTokens,
                brain_completion_tokens AS brainCompletionTokens,
                brain_cache_hit_tokens AS brainCacheHitTokens,
                brain_reasoning_tokens AS brainReasoningTokens,
                brain_usage_calls AS brainUsageCalls,
                updated_at AS updatedAt
         FROM mcp_call_stats WHERE request_id = ?`,
        [requestId],
    );
    if (!row) return null;
    return row;
}

/** Header metrics for Observatory (F-TEL-01). */
/**
 * Tool labels that came through MCP.
 *
 * The stored value is `MCP:<name>` once ingest has resolved Cursor's `CallDynamicTool` wrapper to the
 * real tool — and `mcp:<name>` when the tool list is derived from transcript `llm_call` rows instead,
 * so the match has to be case-insensitive.
 *
 * This exists because two different things were both being called "MCP calls": the *tool* calls a turn
 * made (Jira, search, browser) and the *model* calls it made through an MCP server (DeepSeek brain,
 * executor, Pro). They share the transport and nothing else — different counts, different costs — so
 * they need different labels. The token card used to show only the model figure under the label "MCP
 * calls", which read as the tool count: a turn with 5 Jira/search/browser calls displayed no MCP
 * activity at all.
 */
const MCP_TOOL_RE = /^mcp:/i;

/**
 * @param {Array<{tool: string, count: number}>} tools
 * @returns {{ mcpToolCalls: number, mcpToolKinds: number }}
 */
export function mcpToolBreakdown(tools) {
    const rows = (tools || []).filter((t) => MCP_TOOL_RE.test(String(t?.tool || '')));
    return {
        mcpToolCalls: rows.reduce((a, t) => a + (Number(t?.count) || 0), 0),
        mcpToolKinds: rows.length,
    };
}

export function requestHeaderMetrics(request, mcpCallStats, tools) {
    return {
        callCount: request.call_count ?? 0,
        toolCount: request.tool_count ?? 0,
        inputTokens: request.input_tokens,
        outputTokens: request.output_tokens,
        cacheReadTokens: request.cache_read_tokens,
        cacheWriteTokens: request.cache_write_tokens,
        modelId: request.model_id,
        hasFailures: !!request.has_failures,
        mcpCallStats,
        ...mcpToolBreakdown(tools),
    };
}

export function listDecisions(db, cfg, url) {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number.parseInt(p.get('limit') || '100', 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(p.get('offset') || '0', 10) || 0, 0);
    const where = ['dl.project_id = ?'];
    const params = [cfg.project.id];
    if (p.get('requestId')) {
        where.push('dl.request_id = ?');
        params.push(p.get('requestId'));
    }
    if (p.get('jevMode')) {
        where.push('dl.jev_mode = ?');
        params.push(p.get('jevMode'));
    }
    if (p.get('eventType')) {
        where.push('dl.event_type = ?');
        params.push(p.get('eventType'));
    }
    const clause = where.join(' AND ');

    const total = db.get(`SELECT COUNT(*) AS n FROM decision_ledger dl WHERE ${clause}`, params).n;
    const items = db.all(
        `SELECT dl.id, dl.request_id AS requestId, dl.conversation_id AS conversationId,
                dl.event_type AS eventType, dl.jev_mode AS jevMode,
                dl.resolver_winner AS resolverWinner, dl.enforced_verdict AS enforcedVerdict,
                dl.top_probability AS topProbability, dl.latency_ms_l0 AS latencyMsL0,
                dl.latency_ms_jev AS latencyMsJev, dl.flash_fallback_used AS flashFallbackUsed,
                dl.created_at AS createdAt,
                r.user_query AS userQuery, r.generation_id AS generationId, r.started_at AS requestStartedAt,
                m.flash_brain_count AS flashBrain, m.flash_executor_count AS flashExecutor,
                m.pro_count AS proCount, m.jev_count AS jevCount
         FROM decision_ledger dl
         LEFT JOIN request r ON r.id = dl.request_id AND r.project_id = dl.project_id
         LEFT JOIN mcp_call_stats m ON m.request_id = dl.request_id
         WHERE ${clause}
         ORDER BY dl.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
    );
    const summary = db.get(
        `SELECT
            SUM(CASE WHEN dl.jev_mode = 'shadow' THEN 1 ELSE 0 END) AS shadowRows,
            SUM(CASE WHEN dl.enforced_verdict LIKE 'jev_%' THEN 1 ELSE 0 END) AS jevEnforced,
            SUM(CASE WHEN dl.enforced_verdict = 'hil_only' THEN 1 ELSE 0 END) AS hilOnly,
            AVG(COALESCE(m.pro_count, 0) + COALESCE(m.flash_brain_count, 0) + COALESCE(m.flash_executor_count, 0)) AS avgBrainMcpPerRequest
         FROM decision_ledger dl
         LEFT JOIN mcp_call_stats m ON m.request_id = dl.request_id
         WHERE ${clause}`,
        params,
    );
    return { items, summary, page: { limit, offset, total } };
}
