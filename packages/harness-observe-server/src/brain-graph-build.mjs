/**
 * Brain graph — the workspace panorama behind the Observatory "Brain" page.
 *
 * Contract (see documents/03.state-and-contracts/03.observe-api.md):
 *   GET /api/brain/graph.json -> { version, nodes, links, legend, meta }
 *
 * Why this file owns its own source list: the graph must be built from artifacts this product
 * actually writes (the observe DB). It deliberately does **not** read `route-graph.json`: that
 * artifact was born in a consumer repo with a different shape and is not a contract of this
 * package. If a static route/rule graph is needed later it gets its own product-owned spec and
 * its own builder — not an import of somebody's file.
 *
 * Two rules from documents/05.development/02.invariants.md drive the whole shape:
 *   A2 / D3 / D4 — an absent layer is *reported* (`meta.omitted`), never rendered as empty or zero.
 *   D5 — no invented numbers: every count comes from a row, and any cap is reported in
 *        `meta.truncated` with both `shown` and `total`.
 *
 * Kind -> layer mapping (stable, asserted by the view code):
 *   root  -> core
 *   area  -> memory     (a directory area, derived from touched files)
 *   note  -> memory     (a file that requests actually read or edited)
 *   skill -> skills     (a rule attached to a request)
 *   tool  -> skills     (a tool a request actually called)
 *   run   -> runs       (one request)
 *   app   -> apps       (one harness id seen on an event)
 */

import fs from 'node:fs';
import path from 'node:path';

import { isoNow } from '@mu/harness-foundation';

import { isWithinRoot } from './brain-file-read.mjs';

export const BRAIN_GRAPH_VERSION = 1;

export const BRAIN_LIMITS = Object.freeze({
    runs: 400,
    notes: 800,
    skills: 200,
    tools: 120,
});

export const BRAIN_LAYER_OF_KIND = Object.freeze({
    root: 'core',
    area: 'memory',
    note: 'memory',
    skill: 'skills',
    tool: 'skills',
    run: 'runs',
    app: 'apps',
});

const RUN_ID_CHUNK = 300;

/**
 * Directory area of a path, relative to the project root when the path lives under it.
 * Returns a stable label; two paths in the same top-level directory share one area.
 */
export function areaOfPath(filePath, rootPath) {
    const norm = String(filePath || '').replace(/\\/g, '/');
    const root = String(rootPath || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
    let rel = norm;
    if (root && norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        rel = norm.slice(root.length + 1);
    } else {
        rel = norm.replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '');
    }
    const segments = rel.split('/').filter(Boolean);
    if (segments.length <= 1) return '(root files)';
    return segments[0];
}

/**
 * Cache key for the derived graph. The `-wal` file matters: under WAL a commit can land entirely in
 * the log while the main database file keeps its old mtime, so a key that watches only the database
 * would serve a stale panorama after every ingest.
 */
export function dbFingerprint(target) {
    const parts = [];
    for (const file of [target, `${target}-wal`]) {
        try {
            const stat = fs.statSync(file);
            parts.push(`${stat.mtimeMs}:${stat.size}`);
        } catch {
            parts.push('-');
        }
    }
    return parts.join('|');
}

/**
 * Host path -> path that exists *on this server*.
 *
 * Ingest records what the host saw (`/Users/.../repo/x.md`), but inside the container the same file
 * is mounted at `/data/repo/x.md`. The graph must carry a path the server can actually open, or the
 * Brain card's preview would 403 on every node while the picture looks perfectly fine. This mirrors
 * `toContainerPath()` in ingest-transcript.mjs — same env contract, same direction.
 *
 * `pathHost` is kept on the node so the card can show and copy the path the operator recognises.
 */
export function toServerPath(filePath) {
    if (!filePath) return filePath;
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved)) return resolved;

    const repoHost = process.env.HARNESS_REPO_ROOT_HOST ? path.resolve(process.env.HARNESS_REPO_ROOT_HOST) : null;
    if (repoHost && (resolved === repoHost || resolved.startsWith(`${repoHost}${path.sep}`))) {
        return path.join('/data/repo', path.relative(repoHost, resolved));
    }

    const agentHost = process.env.HARNESS_AGENT_ROOT_HOST ? path.resolve(process.env.HARNESS_AGENT_ROOT_HOST) : null;
    const agentMount = process.env.HARNESS_AGENT_MOUNT || '/agent-repos';
    if (agentHost && (resolved === agentHost || resolved.startsWith(`${agentHost}${path.sep}`))) {
        return path.join(agentMount, path.relative(agentHost, resolved));
    }

    return resolved;
}

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

function placeholders(n) {
    return new Array(n).fill('?').join(',');
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Build the graph. Pure with respect to its inputs: reads only through `db` and `cfg`.
 *
 * @param {{
 *   db: { all: (sql: string, params?: unknown[]) => any[], get: (sql: string, params?: unknown[]) => any },
 *   cfg: { project: { id: string, displayName?: string }, root: string },
 *   limits?: Partial<typeof BRAIN_LIMITS>,
 *   builtAt?: string,
 * }} input
 */
export function buildBrainGraph({ db, cfg, limits = {}, builtAt = isoNow() }) {
    const cap = { ...BRAIN_LIMITS, ...limits };
    const projectId = cfg.project.id;

    const nodes = [];
    const links = [];
    const linkKeys = new Set();
    const sources = [];
    const omitted = [];
    const truncated = [];

    const pushNode = (kind, id, label, extra = {}) => {
        const node = {
            id,
            id,
            kind,
            layer: BRAIN_LAYER_OF_KIND[kind],
            label,
            area: extra.area ?? null,
            path: extra.path ?? null,
            pathHost: extra.pathHost ?? extra.path ?? null,
            previewable: extra.previewable ?? false,
            note: extra.note ?? null,
            changed: extra.changed ?? null,
            degree: 0,
            weight: extra.weight ?? 1,
        };
        nodes.push(node);
        return node;
    };
    const link = (s, t) => {
        const key = `${s}\u0000${t}`;
        if (linkKeys.has(key)) return;
        linkKeys.add(key);
        links.push({ s, t });
    };

    // --- core: the project itself -------------------------------------------------------
    const project = db.get('SELECT id, display_name, root_path, updated_at FROM project WHERE id = ?', [projectId]);
    if (!project) {
        return {
            version: BRAIN_GRAPH_VERSION,
            nodes: [],
            links: [],
            legend: 'No project row — nothing ingested yet.',
            meta: {
                builtAt,
                project: { id: projectId, label: cfg.project.displayName || projectId, rootPath: cfg.root },
                sources: [{ source: 'project', present: false, rows: 0 }],
                omitted: [{ layer: 'all', reason: 'project row missing — database not initialised for this project' }],
                truncated: [],
            },
        };
    }
    sources.push({ source: 'project', present: true, rows: 1 });
    const rootReal = realpathOrNull(project.root_path || cfg.root) ?? path.resolve(project.root_path || cfg.root);
    const rootId = `project:${project.id}`;
    pushNode('root', rootId, project.display_name || project.id, {
        path: project.root_path,
        pathHost: project.root_path,
        note: 'workspace root',
        changed: project.updated_at ?? null,
    });

    // --- runs ---------------------------------------------------------------------------
    const runTotal = num(db.get('SELECT COUNT(*) AS n FROM request WHERE project_id = ?', [projectId])?.n);
    const runs = db.all(
        `SELECT id, conversation_id, boundary_index, user_query, started_at, ended_at, created_at,
                status, model_id, call_count
         FROM request WHERE project_id = ?
         ORDER BY COALESCE(ended_at, started_at, created_at) DESC
         LIMIT ?`,
        [projectId, cap.runs],
    );
    sources.push({ source: 'request', present: true, rows: runTotal });
    if (runTotal > runs.length) {
        truncated.push({ kind: 'run', shown: runs.length, total: runTotal });
    }
    const runIds = new Set();
    for (const run of runs) {
        const id = `run:${run.id}`;
        runIds.add(run.id);
        const query = String(run.user_query || '').replace(/\s+/g, ' ').trim();
        pushNode('run', id, query ? query.slice(0, 72) : run.id, {
            path: null,
            note: `${run.status}${run.model_id ? ` · ${run.model_id}` : ''}`,
            changed: run.ended_at || run.started_at || run.created_at || null,
            weight: Math.max(1, num(run.call_count)),
        });
    }

    // --- notes (files) and their areas ---------------------------------------------------
    const noteTotal = num(
        db.get(
            `SELECT COUNT(DISTINCT rf.path) AS n
             FROM request_file rf JOIN request r ON r.id = rf.request_id
             WHERE r.project_id = ?`,
            [projectId],
        )?.n,
    );
    const noteRows = db.all(
        `SELECT rf.path AS path,
                COUNT(DISTINCT rf.request_id) AS requests,
                MAX(COALESCE(r.ended_at, r.started_at, r.created_at)) AS changed
         FROM request_file rf JOIN request r ON r.id = rf.request_id
         WHERE r.project_id = ?
         GROUP BY rf.path
         ORDER BY requests DESC, rf.path ASC
         LIMIT ?`,
        [projectId, cap.notes],
    );
    sources.push({ source: 'request_file', present: true, rows: noteTotal });
    if (noteTotal > noteRows.length) {
        truncated.push({ kind: 'note', shown: noteRows.length, total: noteTotal });
    }

    const areaIds = new Map();
    const areaNodes = new Map();
    const areaChanged = new Map();
    const noteIdByPath = new Map();
    for (const row of noteRows) {
        const area = areaOfPath(row.path, project.root_path || cfg.root);
        let areaId = areaIds.get(area);
        if (!areaId) {
            areaId = `area:${area}`;
            areaIds.set(area, areaId);
            areaNodes.set(area, pushNode('area', areaId, area, { note: 'directory area', area }));
            link(rootId, areaId);
        }
        if (row.changed) {
            const current = areaChanged.get(area);
            if (!current || String(row.changed) > current) areaChanged.set(area, String(row.changed));
        }
        const noteId = `note:${row.path}`;
        noteIdByPath.set(row.path, noteId);
        const serverPath = toServerPath(row.path);
        pushNode('note', noteId, baseName(row.path), {
            path: serverPath,
            pathHost: row.path,
            // A recorded path is not automatically readable: it can be a directory, or live outside
            // the mount this server sees (/tmp, /Applications). The card must not offer "Open file"
            // for something the route can only answer with 404.
            previewable: isPreviewable(serverPath, rootReal),
            area,
            note: `${num(row.requests)} request(s)`,
            changed: row.changed ?? null,
            weight: num(row.requests),
        });
        link(areaId, noteId);
    }
    // An area's "last change" is the newest file in it — a MAX over recorded rows, not a new fact.
    for (const [area, changed] of areaChanged) {
        const node = areaNodes.get(area);
        if (node) node.changed = changed;
    }

    // --- rules and tools (skills layer) --------------------------------------------------
    const ruleTotal = num(
        db.get(
            `SELECT COUNT(DISTINCT rr.rule_id) AS n
             FROM request_rule rr JOIN request r ON r.id = rr.request_id
             WHERE r.project_id = ?`,
            [projectId],
        )?.n,
    );
    const rules = db.all(
        `SELECT rr.rule_id AS rule_id, COUNT(DISTINCT rr.request_id) AS requests,
                MAX(rr.attached_at) AS changed
         FROM request_rule rr JOIN request r ON r.id = rr.request_id
         WHERE r.project_id = ?
         GROUP BY rr.rule_id ORDER BY requests DESC, rr.rule_id ASC LIMIT ?`,
        [projectId, cap.skills],
    );
    sources.push({ source: 'request_rule', present: true, rows: ruleTotal });
    if (ruleTotal > rules.length) truncated.push({ kind: 'skill', shown: rules.length, total: ruleTotal });
    const ruleIdSet = new Set(rules.map((r) => r.rule_id));
    for (const row of rules) {
        pushNode('skill', `skill:${row.rule_id}`, row.rule_id, {
            note: `${num(row.requests)} request(s)`,
            changed: row.changed ?? null,
            weight: num(row.requests),
        });
    }

    const toolTotal = num(
        db.get(
            `SELECT COUNT(DISTINCT rt.tool) AS n
             FROM request_tool rt JOIN request r ON r.id = rt.request_id
             WHERE r.project_id = ?`,
            [projectId],
        )?.n,
    );
    const tools = db.all(
        `SELECT rt.tool AS tool, SUM(rt.count) AS calls,
                MAX(COALESCE(r.ended_at, r.started_at, r.created_at)) AS changed
         FROM request_tool rt JOIN request r ON r.id = rt.request_id
         WHERE r.project_id = ?
         GROUP BY rt.tool ORDER BY calls DESC, rt.tool ASC LIMIT ?`,
        [projectId, cap.tools],
    );
    sources.push({ source: 'request_tool', present: true, rows: toolTotal });
    if (toolTotal > tools.length) truncated.push({ kind: 'tool', shown: tools.length, total: toolTotal });
    const toolSet = new Set(tools.map((t) => t.tool));
    for (const row of tools) {
        pushNode('tool', `tool:${row.tool}`, row.tool, {
            note: `${num(row.calls)} call(s)`,
            changed: row.changed ?? null,
            weight: num(row.calls),
        });
    }

    // --- harnesses (apps layer): one node per harness id actually seen on an event ---------
    const harnessRows = db.all(
        `SELECT harness, MAX(hook_at) AS changed FROM event WHERE project_id = ? GROUP BY harness`,
        [projectId],
    );
    sources.push({ source: 'event.harness', present: true, rows: harnessRows.length });
    for (const row of harnessRows) {
        pushNode('app', `app:${row.harness}`, row.harness, {
            note: 'harness',
            changed: row.changed ?? null,
        });
    }

    // --- per-run edges (only for the runs actually included above) ------------------------
    const ids = [...runIds];
    for (const part of chunk(ids, RUN_ID_CHUNK)) {
        if (!part.length) break;
        const ph = placeholders(part.length);

        const files = db.all(
            `SELECT DISTINCT request_id, path FROM request_file WHERE request_id IN (${ph})`,
            part,
        );
        for (const row of files) {
            const noteId = noteIdByPath.get(row.path);
            if (noteId) link(`run:${row.request_id}`, noteId);
        }

        const attached = db.all(
            `SELECT DISTINCT request_id, rule_id FROM request_rule WHERE request_id IN (${ph})`,
            part,
        );
        for (const row of attached) {
            if (ruleIdSet.has(row.rule_id)) link(`run:${row.request_id}`, `skill:${row.rule_id}`);
        }

        const called = db.all(
            `SELECT DISTINCT request_id, tool FROM request_tool WHERE request_id IN (${ph})`,
            part,
        );
        for (const row of called) {
            if (toolSet.has(row.tool)) link(`run:${row.request_id}`, `tool:${row.tool}`);
        }

        const harnesses = db.all(
            `SELECT DISTINCT request_id, harness FROM event
             WHERE project_id = ? AND request_id IN (${ph})`,
            [projectId, ...part],
        );
        for (const row of harnesses) {
            link(`run:${row.request_id}`, `app:${row.harness}`);
        }
    }

    // --- routines: honest omission -------------------------------------------------------
    omitted.push({
        layer: 'routines',
        reason: 'no routine registry is ingested yet — a routine node would be an invented fact',
    });

    // --- degree (server-side, one definition) --------------------------------------------
    const degree = new Map();
    for (const l of links) {
        degree.set(l.s, (degree.get(l.s) ?? 0) + 1);
        degree.set(l.t, (degree.get(l.t) ?? 0) + 1);
    }
    for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
    nodes.sort((a, b) => (a.layer === b.layer ? a.id.localeCompare(b.id) : a.layer.localeCompare(b.layer)));

    const legendParts = [
        `${nodes.length} nodes`,
        `${links.length} links`,
    ];
    if (truncated.length) legendParts.push(`capped: ${truncated.map((t) => `${t.kind} ${t.shown}/${t.total}`).join(', ')}`);
    if (omitted.length) legendParts.push(`omitted: ${omitted.map((o) => o.layer).join(', ')}`);

    return {
        version: BRAIN_GRAPH_VERSION,
        nodes,
        links,
        legend: legendParts.join(' · '),
        meta: {
            builtAt,
            project: { id: project.id, label: project.display_name || project.id, rootPath: project.root_path || cfg.root },
            sources,
            omitted,
            truncated,
            limits: cap,
        },
    };
}

function realpathOrNull(target) {
    try {
        return fs.realpathSync(target);
    } catch {
        return null;
    }
}

/**
 * "Can the preview route actually answer for this node?" — the same two gates the route applies
 * (inside the project root, real path, regular file). Anything else is a node the card must not
 * offer to open, even if a path with that name happens to exist on this machine.
 */
function isPreviewable(filePath, rootReal) {
    if (!filePath) return false;
    try {
        const real = fs.realpathSync(filePath);
        return isWithinRoot(rootReal, real) && fs.statSync(real).isFile();
    } catch {
        return false;
    }
}

function baseName(filePath) {
    const norm = String(filePath || '').replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx === -1 ? norm : norm.slice(idx + 1);
}
