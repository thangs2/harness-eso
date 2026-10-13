import { buildLive } from './route-watch.mjs';
import { parseJevRouteBucket } from './observe-jev.mjs';

/**
 * Legacy live snapshot (`buildLive`) + SSE `event: live` fan-out.
 */
export function createLivePublisher(cfg, api, { enqueueToClients, quiet = false, actualPort }) {
    let revision = 0;
    let legacySnapshot = null;

    function loadDecisionsByGeneration() {
        return api.withDb((db) => {
            const rows = db.all(
                `SELECT r.generation_id, dl.resolver_winner, dl.enforced_verdict, dl.event_type,
                        dl.top_probability, dl.jev_response_json, dl.created_at
                 FROM decision_ledger dl
                 INNER JOIN request r ON r.id = dl.request_id AND r.project_id = dl.project_id
                 WHERE dl.project_id = ? AND r.generation_id IS NOT NULL AND dl.event_type = 'turn_start'
                 ORDER BY dl.created_at DESC`,
                [cfg.project.id],
            );
            const map = new Map();
            for (const row of rows) {
                if (!row.generation_id || map.has(row.generation_id)) continue;
                map.set(row.generation_id, {
                    resolverWinner: row.resolver_winner,
                    enforcedVerdict: row.enforced_verdict,
                    eventType: row.event_type,
                    confidence: row.top_probability,
                    routeBucket: parseJevRouteBucket(row.jev_response_json),
                    at: row.created_at,
                });
            }
            return map;
        });
    }

    function loadEvidenceByGeneration() {
        return api.withDb((db) => {
            const rows = db.all(
                `SELECT r.generation_id, dl.jev_response_json, dl.enforced_verdict, dl.top_probability, dl.created_at
                 FROM decision_ledger dl
                 INNER JOIN request r ON r.id = dl.request_id AND r.project_id = dl.project_id
                 WHERE dl.project_id = ? AND r.generation_id IS NOT NULL AND dl.event_type = 'evidence_sufficiency'
                 ORDER BY dl.created_at DESC`,
                [cfg.project.id],
            );
            const map = new Map();
            for (const row of rows) {
                if (!row.generation_id || map.has(row.generation_id)) continue;
                let bundle = null;
                try {
                    const parsed = JSON.parse(row.jev_response_json || '{}');
                    bundle = parsed.bundle ?? parsed;
                } catch {
                    bundle = null;
                }
                map.set(row.generation_id, {
                    level: row.enforced_verdict,
                    score: row.top_probability,
                    bundle,
                    at: row.created_at,
                });
            }
            return map;
        });
    }

    function publishLive() {
        try {
            legacySnapshot = buildLive({
                root: cfg.root,
                port: actualPort?.() ?? null,
                decisionsByGeneration: loadDecisionsByGeneration(),
                evidenceByGeneration: loadEvidenceByGeneration(),
            });
            revision += 1;
            legacySnapshot.revision = revision;
        } catch (err) {
            legacySnapshot = null;
            if (!quiet) console.error(`observe-server: live snapshot failed — ${err.message}`);
            return;
        }
        if (enqueueToClients) {
            enqueueToClients(`event: live\ndata: ${JSON.stringify(legacySnapshot)}\n\n`);
        }
    }

    return {
        publishLive,
        getSnapshot: () => legacySnapshot,
        getRevision: () => revision,
    };
}
