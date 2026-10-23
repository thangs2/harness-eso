import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_NAME } from './repo-root.mjs';
import { claimObservePort, normalizePort } from './observe-port.mjs';

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

export const PRODUCT_STATE_ENV = 'HARNESS_PRODUCT_STATE_DIR';

/**
 * `~/.harness` — the product's own state.
 *
 * This used to default to `<harness-eso>/.harness`, i.e. inside the product checkout. That made
 * the checkout a runtime dependency of the operator workflow: the project registry, the project
 * list and the workspace index all lived in the repo, so `git clean`, a branch switch or moving
 * the checkout silently changed which projects the console could see. It also contradicted the
 * deployment model — the product runs as containers and must not care where the source tree is.
 *
 * Lives next to `~/.harness/observe/`, which already holds the per-project databases, so all
 * product-owned state is under one directory the operator can back up or delete.
 */
export function defaultProductStateDir() {
    return path.join(os.homedir(), '.harness');
}

/** Product install state (`~/.harness` on host, `/data/product-state` in Docker). */
export function productStateDir() {
    return process.env[PRODUCT_STATE_ENV] || defaultProductStateDir();
}

export function workspaceFile() {
    return path.join(productStateDir(), 'workspace.json');
}

export function registryFile() {
    return path.join(productStateDir(), 'registry.json');
}

/**
 * Collapse an absolute path under `$HOME` to its `~` form.
 *
 * Used wherever a path is written into a **consumer** file. A literal `~` keeps that file portable
 * across machines and keeps an absolute host path out of a repo the operator may commit — and
 * `loadConfig` already expands `~` when it reads the registry back.
 */
export function portableStatePath(filePath) {
    if (!filePath) return filePath;
    const home = os.homedir();
    const abs = path.resolve(filePath);
    if (abs === home) return '~';
    if (abs.startsWith(`${home}${path.sep}`)) return `~${abs.slice(home.length)}`;
    return filePath;
}

export function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || '';
}

export function ensureProductState() {
    const dir = productStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const ws = workspaceFile();
    if (!fs.existsSync(ws)) {
        writeJsonAtomic(ws, { version: WORKSPACE_VERSION, defaultProjectId: null, projects: [] });
    }
}

/*
 * Registry migration: v1 (two sources) -> v2 (one).
 *
 * v1 kept a project in two files that had to be written together by hand: a thin row in this
 * `workspace.json` (`id`, `root`, `port`, `profile`) and the real document in `projects/<id>.json`
 * (`status`, `plugins`, `hostMode`, `observe.port`). Every writer wrote both, and every reader read
 * one of them. The two disagreed on this machine: `/api/projects` listed 2 projects because it read
 * the per-project files, while `/api/observe-ports` listed 4 because it read the workspace, and
 * `baplatform` carried `agentRepo.root: ""` in the document while the workspace knew its root.
 *
 * v2 keeps the full document inline and folds the row into it, so a field cannot exist in one place
 * and be missing in the other. `projects/` is then deleted — see `migrateProjectDocuments()`.
 *
 * The migration runs once, on first load, and only when `version < 2`. It never deletes anything it
 * could not read: an unparseable document is reported and left on disk.
 */
export const WORKSPACE_VERSION = 2;

export const LEGACY_PROJECTS_SUBDIR = 'projects';

export function legacyProjectsDir() {
    return path.join(productStateDir(), LEGACY_PROJECTS_SUBDIR);
}

function readLegacyProjectDocs() {
    const dir = legacyProjectsDir();
    if (!fs.existsSync(dir)) return { docs: [], broken: [] };
    const docs = [];
    const broken = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (doc && doc.id) docs.push(doc);
            else broken.push(file);
        } catch {
            broken.push(file);
        }
    }
    return { docs, broken };
}

/**
 * Fold a row and a legacy document into one entry. The row wins where the two differ, because it is
 * the one `claimObservePort` and the compose stack already act on — a migration that "fixed" a port
 * here would silently move a consumer's Observatory.
 */
export function mergeProjectEntry(row, doc) {
    const merged = {
        ...(doc || {}),
        ...(row || {}),
        id: row?.id || doc?.id,
    };
    merged.displayName = row?.displayName || doc?.displayName || merged.id;
    // `rootHost` is the host path; `root` is what the process can open. Carry both, and fall back to
    // whichever exists so a project registered before `rootHost` existed is not lost.
    merged.root = row?.root || doc?.agentRepo?.root || '';
    merged.rootHost = row?.rootHost || merged.root;
    merged.observe = {
        ...(doc?.observe || {}),
        // A legacy document's port was a second copy. The claimed row is the one the stack uses.
        port: normalizePort(row?.port) ?? normalizePort(doc?.observe?.port),
    };
    merged.agentRepo = { ...(doc?.agentRepo || {}), root: merged.root };
    merged.profile = row?.profile || doc?.profile || 'generic-eso';
    merged.plugins = doc?.plugins || merged.plugins || {};
    merged.status = doc?.status || merged.status || 'draft';
    if (!merged.hostMode) merged.hostMode = 'dual-ide';
    return merged;
}

/**
 * One-time fold of `projects/*.json` into `workspace.json`.
 *
 * Returns what happened so a caller (CLI, Console boot, `reconcile-observe-ports`) can print it
 * once instead of silently rewriting the operator's state directory.
 */
export function migrateProjectDocuments() {
    ensureProductState();
    const doc = readJson(workspaceFile());
    const version = doc.version ?? 1;
    const rows = Array.isArray(doc.projects) ? doc.projects : [];
    const { docs, broken } = readLegacyProjectDocs();
    const hasLegacy = fs.existsSync(legacyProjectsDir());

    if (version >= WORKSPACE_VERSION && !hasLegacy) {
        return { migrated: false, version, folded: 0, adopted: 0, dropped: 0, broken: [] };
    }

    const byId = new Map();
    const order = [];
    const push = (entry) => {
        if (!entry?.id) return;
        if (!byId.has(entry.id)) order.push(entry.id);
        byId.set(entry.id, entry);
    };

    for (const row of rows) {
        const legacy = docs.find((d) => d.id === row.id) || null;
        push(mergeProjectEntry(row, legacy));
    }
    // A document with no row was a project the Console could see and the CLI could not. Adopting it
    // is the point of the merge: it was real, it had a port, it just never reached this file.
    const rowIds = new Set(rows.map((r) => r?.id));
    let adopted = 0;
    for (const legacyDoc of docs) {
        if (rowIds.has(legacyDoc.id)) continue;
        adopted += 1;
        push(mergeProjectEntry({ id: legacyDoc.id }, legacyDoc));
    }

    const projects = order.map((id) => byId.get(id));
    const dropped = rows.length + adopted - projects.length;
    const next = {
        ...doc,
        version: WORKSPACE_VERSION,
        defaultProjectId: doc.defaultProjectId || projects[0]?.id || null,
        projects,
    };
    writeJsonAtomic(workspaceFile(), next);

    // Only after the new file is on disk AND parses back. A half-written registry is worse than two.
    let removedDir = false;
    if (hasLegacy && broken.length === 0) {
        try {
            const reread = readJson(workspaceFile());
            if ((reread.version ?? 1) >= WORKSPACE_VERSION && Array.isArray(reread.projects)) {
                fs.rmSync(legacyProjectsDir(), { recursive: true, force: true });
                removedDir = true;
            }
        } catch {
            /* leave the folder in place; the next load retries */
        }
    }

    return {
        migrated: true,
        version: WORKSPACE_VERSION,
        folded: docs.length - adopted,
        adopted,
        dropped,
        broken,
        removed: removedDir,
    };
}

export function loadWorkspace() {
    ensureProductState();
    migrateProjectDocuments();
    const doc = readJson(workspaceFile());
    return {
        version: doc.version ?? WORKSPACE_VERSION,
        defaultProjectId: doc.defaultProjectId ?? null,
        projects: Array.isArray(doc.projects) ? doc.projects : [],
    };
}

export function saveWorkspace(doc) {
    ensureProductState();
    writeJsonAtomic(workspaceFile(), { ...doc, version: Math.max(doc.version ?? 0, WORKSPACE_VERSION) });
}

/** Read one project's full document. The registry is the document; there is no second file. */
export function loadProjectEntry(id) {
    return findProject(loadWorkspace(), id);
}

/**
 * Apply a change to one project in the registry, atomically with respect to other writers.
 *
 * Replaces the old `saveProject(stateDir, doc)`, which wrote a separate file. Callers that used to
 * spread a modified document now pass a patch; `undefined` fields are ignored so a partial patch
 * cannot erase `plugins` or `hostMode`.
 */
export function updateProjectEntry(id, patch) {
    const workspace = loadWorkspace();
    const idx = workspace.projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`unknown project: ${id}`);
    const next = { ...workspace.projects[idx], ...stripUndefined(patch), id };
    next.updatedAt = new Date().toISOString();
    workspace.projects[idx] = next;
    saveWorkspace(workspace);
    return next;
}

function stripUndefined(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch || {})) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/*
 * Duplicated from `project-registry.mjs` on purpose: the registry writer must not import the module
 * that imports it. `project-registry.mjs` re-exports its own `defaultPlugins()`, and a test pins the
 * two to the same shape, so a policy default cannot drift between a Console-created draft and one
 * created through the CLI.
 */
function defaultPluginsForRegistry() {
    return {
        law: { adapterId: 'docgraph-cli' },
        code: { adapterId: 'codegraph-cli' },
        memory: { adapterId: 'noop-memory' },
        jev: { adapterId: 'off', mode: 'off' },
        l3_route: { adapterId: 'off' },
        brain: { adapterId: 'deepseek-mcp' },
    };
}

export function addProjectEntry(entry) {
    const workspace = loadWorkspace();
    const idx = workspace.projects.findIndex((p) => p.id === entry.id);
    const now = new Date().toISOString();
    const next = { createdAt: now, status: 'draft', hostMode: 'dual-ide', ...entry };
    next.plugins = entry.plugins ?? defaultPluginsForRegistry();
    next.updatedAt = now;
    if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...next };
    else workspace.projects.push(next);
    if (!workspace.defaultProjectId) workspace.defaultProjectId = next.id;
    saveWorkspace(workspace);
    syncProjectsFromWorkspace(workspace);
    return next;
}

export function removeProjectEntry(id) {
    const workspace = loadWorkspace();
    const before = workspace.projects.length;
    workspace.projects = workspace.projects.filter((p) => p.id !== id);
    if (workspace.defaultProjectId === id) workspace.defaultProjectId = workspace.projects[0]?.id ?? null;
    saveWorkspace(workspace);
    syncProjectsFromWorkspace(workspace);
    return { removed: before - workspace.projects.length };
}

export function findProject(workspace, id) {
    return workspace.projects.find((p) => p.id === id) ?? null;
}

export function findProjectByRoot(workspace, rootPath) {
    if (!rootPath || !Array.isArray(workspace?.projects)) return null;
    const abs = path.resolve(rootPath);
    return workspace.projects.find((p) => {
        const r1 = p.root ? path.resolve(p.root) : '';
        const r2 = p.rootHost ? path.resolve(p.rootHost) : '';
        return r1 === abs || r2 === abs;
    }) ?? null;
}

export function resolveProject(workspace, idOrNull) {
    const id = idOrNull || workspace.defaultProjectId;
    if (!id) {
        throw new Error('chưa có dự án — thêm dự án trong tab Projects (hoặc: harnessctl configure add)');
    }
    const p = findProject(workspace, id);
    if (!p) throw new Error(`không tìm thấy dự án: ${id}`);
    return p;
}

export function syncProjectsFromWorkspace(workspace) {
    // The project anchor is what a consumer's own tools read, so the port here is the same one
    // `observeUrlFor` hands out — not a second `|| 8792` that can disagree with the registry.
    const registry = workspace.projects.map((p) => ({
        id: p.id,
        root: p.root,
        configPath: path.join(p.root, 'harness.config.json'),
        serverUrl: `http://127.0.0.1:${normalizePort(p.port) ?? claimObservePort(workspace, p.id)}`,
    }));
    writeJsonAtomic(registryFile(), { registry });
}

/**
 * Map host absolute path → path writable inside observe container.
 * @param {string} inputPath
 */
export function resolveAgentRepoPath(inputPath) {
    const raw = path.resolve(inputPath.trim());
    const hostRoot = process.env.HARNESS_AGENT_ROOT_HOST;
    const mount = process.env.HARNESS_AGENT_MOUNT || '/agent-repos';
    if (hostRoot) {
        const normHost = path.resolve(hostRoot);
        if (raw === normHost || raw.startsWith(`${normHost}${path.sep}`)) {
            const rel = path.relative(normHost, raw);
            return path.join(mount, rel);
        }
    }
    return raw;
}

function loadProfile(profileName) {
    const dir = profilesDir();
    if (!dir) throw new Error('HARNESS_PROFILES_DIR not set');
    const profilePath = path.join(dir, `${profileName}.json`);
    if (!fs.existsSync(profilePath)) throw new Error(`profile not found: ${profileName}`);
    return readJson(profilePath);
}

function defaultHarnessConfig({ projectId, displayName, port, registryPath }) {
    return {
        version: 1,
        project: { id: projectId, displayName: displayName || projectId },
        tracking: { enabled: true, sentinelPath: '.harness/DISABLED' },
        storage: {
            driver: 'sqlite',
            sqlite: { path: '.harness/harness.db' },
            remote: { url: null, tokenEnv: 'HARNESS_MONITOR_TOKEN', timeoutMs: 5000 },
        },
        server: { host: '127.0.0.1', port },
        ingest: {
            pollMs: 2000,
            harnesses: [
                {
                    id: 'cursor',
                    tree: '.cursor',
                    shape: 'cursor',
                    spine: 'jsonl-transcript',
                    spineOptions: { transcriptDir: null },
                },
                {
                    id: 'agents',
                    tree: '.agents',
                    shape: 'antigravity',
                    spine: 'jsonl-transcript',
                    spineOptions: { brainDir: '~/.gemini/antigravity-ide/brain' },
                },
            ],
        },
        registry: { mode: 'isolated', registry: registryPath },
    };
}

export function configureAdd(opts) {
    if (!opts._workspaceRegisterOnly) {
        throw new Error(
            'configure add is disabled — consumer files must be created only via: ./harness init profile <consumer-path>',
        );
    }
    const consumerPath = resolveAgentRepoPath(opts.consumerPath);
    if (!fs.existsSync(consumerPath) || !fs.statSync(consumerPath).isDirectory()) {
        throw new Error(`không phải thư mục hợp lệ: ${opts.consumerPath}`);
    }

    const projectId = opts.projectId || path.basename(consumerPath);
    const displayName = opts.displayName || projectId;
    // Allocated through the one resolver: an explicit `opts.port` is a preference, a conflict is an
    // error, and the recorded port wins over both. There is no `|| 8792` here any more.
    const workspace = loadWorkspace();
    const port = claimObservePort(workspace, projectId, { preferred: opts.port });
    const profile = opts.profile || 'generic-eso';

    const runtimeDir = path.join(consumerPath, '.harness');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const configPath = path.join(consumerPath, CONFIG_NAME);
    let createdConfig = false;
    const registryPath = registryFile();
    if (!fs.existsSync(configPath)) {
        writeJsonAtomic(
            configPath,
            defaultHarnessConfig({
                projectId,
                displayName,
                port,
                registryPath: registryPath,
            }),
        );
        createdConfig = true;
    }

    const policyPath = path.join(runtimeDir, 'decision-policy.json');
    let createdPolicy = false;
    if (!fs.existsSync(policyPath)) {
        writeJsonAtomic(policyPath, loadProfile(profile));
        createdPolicy = true;
    }

    const hostPath = path.resolve(String(opts.consumerPath).trim());
    const row = {
        id: projectId,
        displayName,
        root: consumerPath,
        rootHost: hostPath,
        port,
        profile,
    };    const idx = workspace.projects.findIndex((p) => p.id === projectId);
    if (idx >= 0) workspace.projects[idx] = { ...workspace.projects[idx], ...row };
    else workspace.projects.push(row);
    if (!workspace.defaultProjectId || workspace.projects.length === 1) {
        workspace.defaultProjectId = projectId;
    }
    saveWorkspace(workspace);
    syncProjectsFromWorkspace(workspace);

    return {
        ok: true,
        consumerPath,
        projectId,
        configPath,
        policyPath,
        workspaceFile: workspaceFile(),
        registryFile: registryPath,
        serverUrl: `http://127.0.0.1:${port}`,        created: { config: createdConfig, policy: createdPolicy },
    };
}

export function configureUse(projectId) {
    const workspace = loadWorkspace();
    if (!workspace.projects.some((p) => p.id === projectId)) {
        throw new Error(`unknown project: ${projectId}`);
    }
    workspace.defaultProjectId = projectId;
    saveWorkspace(workspace);
    return { ok: true, defaultProjectId: projectId, needsObserveRestart: true };
}

export function configureList() {
    const workspace = loadWorkspace();
    return {
        ok: true,
        defaultProjectId: workspace.defaultProjectId,
        projects: workspace.projects,
        workspaceFile: workspaceFile(),
    };
}
