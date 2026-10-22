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
 * the checkout a runtime dependency of the operator workflow: the project registry, the tenant
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

export function tenantsFile() {
    return path.join(productStateDir(), 'tenants.json');
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
        writeJsonAtomic(ws, { version: 1, defaultProjectId: null, projects: [] });
    }
}

export function loadWorkspace() {
    ensureProductState();
    const doc = readJson(workspaceFile());
    return {
        version: doc.version ?? 1,
        defaultProjectId: doc.defaultProjectId ?? null,
        projects: Array.isArray(doc.projects) ? doc.projects : [],
    };
}

export function saveWorkspace(doc) {
    ensureProductState();
    writeJsonAtomic(workspaceFile(), doc);
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

export function syncTenantsFromWorkspace(workspace) {
    // The tenant anchor is what a consumer's own tools read, so the port here is the same one
    // `observeUrlFor` hands out — not a second `|| 8792` that can disagree with the registry.
    const tenants = workspace.projects.map((p) => ({
        id: p.id,
        root: p.root,
        configPath: path.join(p.root, 'harness.config.json'),
        serverUrl: `http://127.0.0.1:${normalizePort(p.port) ?? claimObservePort(workspace, p.id)}`,
    }));
    writeJsonAtomic(tenantsFile(), { tenants });
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

function defaultHarnessConfig({ projectId, displayName, port, tenantsRegistryPath }) {
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
        tenancy: { mode: 'isolated', registry: tenantsRegistryPath },
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
    const registryPath = tenantsFile();
    if (!fs.existsSync(configPath)) {
        writeJsonAtomic(
            configPath,
            defaultHarnessConfig({
                projectId,
                displayName,
                port,
                tenantsRegistryPath: registryPath,
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
    syncTenantsFromWorkspace(workspace);

    return {
        ok: true,
        consumerPath,
        projectId,
        configPath,
        policyPath,
        workspaceFile: workspaceFile(),
        tenantsFile: registryPath,
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
