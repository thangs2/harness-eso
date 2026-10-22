import fs from 'node:fs';
import { isTrackingDisabled } from './observe-config.mjs';
import { dbCounts, openDb } from './observe-db.mjs';
import { loadDecisionFlowForConversation, loadDecisionFlowForRequest } from './decision-flow.mjs';
import { aggregates } from './aggregates.mjs';
import { listCalls, listDecisions, requestDetail } from './observe-request-detail.mjs';
import { enrichRequestListRow } from './request-list-enrich.mjs';

export function createApiHelpers(cfg, { startedAt, actualPort }) {
    function withDb(fn) {
        const db = openDb(cfg.storage.target);
        try {
            return fn(db);
        } finally {
            db.close();
        }
    }

    function tenantInfo() {
        return withDb((db) => {
            const counts = dbCounts(db);
            return {
                id: cfg.project.id,
                displayName: cfg.project.displayName,
                rootPath: cfg.root,
                configPath: cfg.configPath,
                enabled: !isTrackingDisabled(cfg),
                sentinelPath: cfg.sentinelPath,
                sentinelExists: fs.existsSync(cfg.sentinelPath),
                storage: { driver: cfg.storage.driver, target: cfg.storage.target, remoteUrl: cfg.storage.remoteUrl },
                server: {
                    host: cfg.server.host,
                    port: actualPort(),
                    url: `http://${cfg.server.host}:${actualPort()}`,
                },
                transcriptDir: cfg.ingest.transcriptDir,
                hookFiles: cfg.ingest.hookFiles,
                counts,
                startedAt,
            };
        });
    }

    function listRequests(url) {
        const p = url.searchParams;
        const limit = Math.min(Math.max(Number.parseInt(p.get('limit') || '50', 10) || 50, 1), 500);
        const offset = Math.max(Number.parseInt(p.get('offset') || '0', 10) || 0, 0);
        const where = ['r.project_id = ?'];
        const params = [cfg.project.id];
        if (p.get('status')) {
            where.push('r.status = ?');
            params.push(p.get('status'));
        }
        if (p.get('hasFailures') === '1') where.push('r.has_failures = 1');
        if (p.get('conversationId')) {
            where.push('r.conversation_id = ?');
            params.push(p.get('conversationId'));
        }
        if (p.get('q')) {
            where.push('r.user_query LIKE ?');
            params.push(`%${p.get('q')}%`);
        }
        if (p.get('from')) {
            where.push('r.started_at >= ?');
            params.push(p.get('from'));
        }
        if (p.get('to')) {
            where.push('r.started_at <= ?');
            params.push(p.get('to'));
        }
        if (p.get('ide') === 'cursor') {
            where.push("(c.transcript_path LIKE '%cursor%' OR c.transcript_path LIKE '%agent-transcripts%')");
        } else if (p.get('ide') === 'antigravity') {
            where.push("(c.transcript_path LIKE '%antigravity%' OR c.transcript_path LIKE '%/brain/%')");
        }
        const clause = where.join(' AND ');

        return withDb((db) => {
            const total = db.get(
                `SELECT COUNT(*) AS n FROM request r LEFT JOIN conversation c ON r.conversation_id = c.id WHERE ${clause}`,
                params,
            ).n;
            const rows = db.all(
                `SELECT r.id, r.generation_id AS generationId, r.conversation_id AS conversationId, r.boundary_index AS boundaryIndex,
                        r.user_query AS userQuery, r.started_at AS startedAt, r.ended_at AS endedAt, r.status,
                        r.stop_status AS stopStatus,
                        r.call_count AS callCount, r.tool_count AS toolCount,
                        r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
                        r.cache_read_tokens AS cacheReadTokens, r.cache_write_tokens AS cacheWriteTokens,
                        r.model_id AS modelId, r.has_failures AS hasFailures,
                        r.checks_pass AS checksPass, r.checks_fail AS checksFail,
                        r.list_decision_verdict AS decisionVerdict,
                        r.list_emit_chars_sum AS emitCharsSum,
                        r.list_stop_input_tokens AS stopInputTokens,
                        r.list_stop_output_tokens AS stopOutputTokens,
                        c.transcript_path AS transcriptPath
                 FROM request r
                 LEFT JOIN conversation c ON r.conversation_id = c.id
                 WHERE ${clause}
                 ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.boundary_index DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset],
            );
            const items = rows.map((row) => enrichRequestListRow(row));
            return { items, page: { limit, offset, total } };
        });
    }

    function getRequestDetail(id) {
        return withDb((db) => requestDetail(db, cfg, id));
    }

    function getCalls(url) {
        return withDb((db) => listCalls(db, cfg, url));
    }

    function getDecisions(url) {
        return withDb((db) => listDecisions(db, cfg, url));
    }

    function getAggregates(url) {
        return withDb((db) => aggregates(db, cfg, url));
    }

    function getDecisionFlow(url) {
        const requestId = url.searchParams.get('requestId');
        const conversationId = url.searchParams.get('conversationId');
        return withDb((db) => {
            if (requestId) {
                const flow = loadDecisionFlowForRequest(db, cfg.project.id, requestId);
                return flow ? { ok: true, flow } : { ok: false };
            }
            if (conversationId) {
                const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '80', 10) || 80, 200);
                return { ok: true, flow: loadDecisionFlowForConversation(db, cfg.project.id, conversationId, limit) };
            }
            return { ok: false, error: 'requestId or conversationId required' };
        });
    }

    function tenants() {
        try {
            if (!cfg.tenancy?.registry || !fs.existsSync(cfg.tenancy.registry)) {
                return { items: [{ id: cfg.project.id, rootPath: cfg.root, db: cfg.storage.target }], registry: cfg.tenancy?.registry, exists: false };
            }
            const raw = JSON.parse(fs.readFileSync(cfg.tenancy.registry, 'utf8'));
            return { tenants: raw.tenants || [], registry: cfg.tenancy.registry, exists: true, self: cfg.project.id };
        } catch (err) {
            return { tenants: [], registry: cfg.tenancy?.registry, exists: true, error: err.message };
        }
    }

    /**
     * Gate decisions recorded by the runtime plugin (prompt rejections and denied tool calls).
     * Parameterised by `kind`, `tool` and `limit`; newest first.
     */
    function getGateEvents(url) {
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
        const kind = url.searchParams.get('kind');
        const tool = url.searchParams.get('tool');
        const where = ['project_id = ?'];
        const params = [cfg.project.id];
        if (kind) {
            where.push('kind = ?');
            params.push(kind);
        }
        if (tool) {
            where.push('tool = ?');
            params.push(tool);
        }
        return withDb((db) => {
            const total = db.get(`SELECT COUNT(*) AS n FROM gate_event WHERE ${where.join(' AND ')}`, params);
            const rows = db.all(
                `SELECT id, at, kind, host, event, tool, ref, detail, blockers_json, source_path, source_line_no
                 FROM gate_event WHERE ${where.join(' AND ')}
                 ORDER BY at DESC, id DESC LIMIT ?`,
                [...params, limit],
            );
            return {
                items: rows.map((row) => ({
                    ...row,
                    blockers: (() => {
                        try {
                            return JSON.parse(row.blockers_json || '[]');
                        } catch {
                            return [];
                        }
                    })(),
                })),
                total: total?.n ?? 0,
                limit,
            };
        });
    }

    /** Counts for the Gate panel: by kind, by host, by tool, plus the newest timestamp. */
    function getGateSummary() {
        return withDb((db) => {
            const byKind = db.all(
                'SELECT kind, COUNT(*) AS n FROM gate_event WHERE project_id = ? GROUP BY kind ORDER BY n DESC',
                [cfg.project.id],
            );
            const byTool = db.all(
                `SELECT tool, COUNT(*) AS n FROM gate_event
                 WHERE project_id = ? AND tool IS NOT NULL GROUP BY tool ORDER BY n DESC LIMIT 10`,
                [cfg.project.id],
            );
            const byRef = db.all(
                `SELECT ref, COUNT(*) AS n FROM gate_event
                 WHERE project_id = ? AND ref IS NOT NULL GROUP BY ref ORDER BY n DESC LIMIT 10`,
                [cfg.project.id],
            );
            const latest = db.get('SELECT MAX(at) AS at FROM gate_event WHERE project_id = ?', [cfg.project.id]);
            return { byKind, byTool, byRef, latestAt: latest?.at ?? null, trailPath: cfg.gateTrailPath ?? null };
        });
    }

    return {
        withDb,
        tenantInfo,
        listRequests,
        getRequestDetail,
        getCalls,
        getDecisions,
        getAggregates,
        getDecisionFlow,
        getGateEvents,
        getGateSummary,
        tenants,
    };
}
