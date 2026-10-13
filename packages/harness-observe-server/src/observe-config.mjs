import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    CONFIG_NAME,
    decisionPolicyFile,
    expandHome,
    findConfigPath,
    isoNow,
} from '@mu/harness-foundation';

export { isoNow };

export function cursorProjectSlug(rootPath) {
    return path.resolve(rootPath).replace(/^\/+/, '').replace(/[/\\]/g, '-');
}

/**
 * Cursor slug is derived from the **host** consumer path. In Docker, config `root` is `/data/repo`
 * while transcripts live under `~/.cursor/projects/<host-slug>/`.
 */
export function consumerRootForCursorSlug(containerRoot) {
    const host =
        process.env.HARNESS_REPO_ROOT_HOST ||
        process.env.HARNESS_CURSOR_PROJECT_ROOT ||
        '';
    if (host && !host.startsWith('/data/')) {
        return path.resolve(host);
    }
    const mounted = path.resolve(containerRoot);
    if (mounted === '/data/repo') {
        const fromEnv = process.env.HARNESS_REPO_ROOT;
        if (fromEnv && !String(fromEnv).startsWith('/data/')) {
            return path.resolve(fromEnv);
        }
    }
    return containerRoot;
}

/** Cursor agent-transcripts dir for a consumer repo root (host or Docker mount). */
export function cursorTranscriptDirForRoot(rootPath, cursorHome = path.join(os.homedir(), '.cursor')) {
    const slug = cursorProjectSlug(consumerRootForCursorSlug(rootPath));
    return path.join(cursorHome, 'projects', slug, 'agent-transcripts');
}

/** @deprecated use cursorTranscriptDirForRoot */
export function cursorTranscriptDir(rootPath) {
    return cursorTranscriptDirForRoot(rootPath);
}

/**
 * REQUEST list in Observatory comes from transcript JSONL (not from chat UI alone).
 * In Docker, default `~/.cursor` inside the container is empty — prefer `/host-cursor` mount.
 */
export function resolveIngestTranscriptDir(root, configIngest) {
    if (process.env.HARNESS_INGEST_TRANSCRIPT_DIR) {
        return process.env.HARNESS_INGEST_TRANSCRIPT_DIR;
    }
    if (configIngest && configIngest.transcriptDir) {
        return configIngest.transcriptDir;
    }
    const mountEnv = process.env.HARNESS_CURSOR_MOUNT;
    const mountBase = mountEnv || '/host-cursor';
    const mounted = cursorTranscriptDirForRoot(root, mountBase);
    if (fs.existsSync(mounted)) {
        return mounted;
    }
    // In Docker, compose sets HARNESS_CURSOR_MOUNT — keep that path in diagnostics even if the volume is missing.
    if (mountEnv) {
        return mounted;
    }
    const host = cursorTranscriptDirForRoot(root);
    if (fs.existsSync(host)) {
        return host;
    }
    return host;
}

export function antigravityBrainDirs() {
    return [
        path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    ].filter((d) => fs.existsSync(d));
}

/** `~/.harness/observe` — one home for every project's database, outside every consumer repo. */
export function defaultObserveDataRoot() {
    return path.join(os.homedir(), '.harness', 'observe');
}

/**
 * Writable observe state (SQLite, blobs) vs consumer repo root.
 *
 * Resolution order:
 *   1. `HARNESS_SQLITE_PATH`   — exact file (highest precedence)
 *   2. absolute `storage.sqlite.path` in `harness.config.json` — an explicit operator choice
 *   3. `HARNESS_DATA_ROOT`     — Docker sets `/data/observe`
 *   4. `~/.harness/observe`    — the host default
 *
 * The fallback used to be `<consumer>/.harness/harness.db`, and that is what put a 38 MB database
 * plus its `-wal`/`-shm` siblings inside the consumer's working tree. Two consequences, both bad:
 * the same project ended up with two divergent databases (one in the repo, one in the data root),
 * and every consumer repo collected machine state that showed up in `git status`.
 *
 * A *relative* `storage.sqlite.path` is no longer joined onto the consumer root. It is treated as a
 * legacy hint and ignored: the config cannot be allowed to place a database in a git working tree
 * by accident. An operator who genuinely wants it in the repo must say so with an absolute path.
 *
 * @param {string} root consumer repo root (config dir parent) — kept for absolute-path resolution
 * @param {string} projectId from harness.config `project.id`
 * @param {object} [configStorage] harness.config `storage`
 */
export function resolveObserveStoragePaths(root, projectId, configStorage) {
    const storage = configStorage || {};
    const declared = storage.sqlite && storage.sqlite.path;

    const sqliteOverride = process.env.HARNESS_SQLITE_PATH;
    if (sqliteOverride) {
        const target = path.resolve(sqliteOverride);
        const dataDir = process.env.HARNESS_DATA_ROOT
            ? path.resolve(process.env.HARNESS_DATA_ROOT)
            : path.dirname(target);
        return { dataDir, storageTarget: target };
    }

    if (declared && path.isAbsolute(declared)) {
        return { dataDir: path.dirname(declared), storageTarget: declared };
    }

    const dataRoot = process.env.HARNESS_DATA_ROOT
        ? path.resolve(process.env.HARNESS_DATA_ROOT)
        : defaultObserveDataRoot();
    const id = projectId || 'default';
    const tenantDir = path.join(dataRoot, id);
    void root;
    return { dataDir: tenantDir, storageTarget: path.join(tenantDir, 'harness.db') };
}

export function loadConfig(startDir = process.cwd()) {
    const configPath = findConfigPath(startDir);
    if (!configPath) {
        return { ok: false, reason: `no ${CONFIG_NAME} found walking up from ${path.resolve(startDir)}` };
    }
    const root = path.dirname(configPath);
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        return { ok: false, reason: `invalid JSON in ${configPath}: ${err.message}`, configPath, root };
    }

    const project = config.project || { id: path.basename(root), displayName: path.basename(root) };
    const storage = config.storage || {};
    const { dataDir, storageTarget } = resolveObserveStoragePaths(root, project.id, storage);
    const sentinel = (config.tracking && config.tracking.sentinelPath) || '.harness/DISABLED';
    const transcriptDir = resolveIngestTranscriptDir(root, config.ingest);

    return {
        ok: true,
        root,
        configPath,
        dataDir,
        config,
        project,
        enabled: config.tracking ? config.tracking.enabled !== false : true,
        sentinelPath: path.isAbsolute(sentinel) ? sentinel : path.join(root, sentinel),
        storage: {
            driver: storage.driver || 'sqlite',
            target: storageTarget,
            remoteUrl: storage.remote ? storage.remote.url : null,
        },
        server: {
            host:
                process.env.HARNESS_SERVER_HOST ||
                (config.server && config.server.host) ||
                '127.0.0.1',
            port: process.env.HARNESS_SERVER_PORT
                ? Number.parseInt(process.env.HARNESS_SERVER_PORT, 10)
                : (config.server && config.server.port) || 8792,
        },
        ingest: {
            pollMs: process.env.HARNESS_INGEST_POLL_MS
                ? Number.parseInt(process.env.HARNESS_INGEST_POLL_MS, 10)
                : (config.ingest && config.ingest.pollMs) || 2000,
            transcriptDir,
            brainDirs: antigravityBrainDirs(),
            hookFiles: ((config.ingest && config.ingest.hookFiles) || [
                '.cursor/session/route-trace.jsonl',
                '.agents/session/route-trace.jsonl',
            ]).map((f) => (path.isAbsolute(f) ? f : path.join(root, f))),
        },
        tenancy: {
            mode: (config.tenancy && config.tenancy.mode) || 'isolated',
            registry: expandHome((config.tenancy && config.tenancy.registry) || '~/.harness/tenants.json'),
        },
        decisionPolicyPath: decisionPolicyFile(root),
    };
}

export function isTrackingDisabled(cfg) {
    if (!cfg.enabled) return true;
    return fs.existsSync(cfg.sentinelPath);
}
