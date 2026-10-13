import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_NAME } from './repo-root.mjs';
import { portableStatePath, resolveAgentRepoPath, writeJsonAtomic } from './workspace-store.mjs';
import {
    HOST_PACK_REL,
    addHostProfile,
    applyHostProfile,
    applyHostProfiles,
    applyHostTree,
    hostPackStatus,
    installHostPack,
    loadHostProfile,
    listHostProfileIds,
    packVersion,
    removeHostTree,
    verifyHostPack,
} from './host-install.mjs';

export {
    addHostProfile,
    applyHostProfile,
    applyHostProfiles,
    applyHostTree,
    hostPackStatus,
    installHostPack,
    loadHostProfile,
    listHostProfileIds,
    packVersion,
    removeHostTree,
    verifyHostPack,
};

export const PROJECTS_SUBDIR = 'projects';

export function projectsDir(stateDir) {
    return path.join(stateDir, PROJECTS_SUBDIR);
}

export function projectFile(stateDir, id) {
    return path.join(projectsDir(stateDir), `${id}.json`);
}

function slugify(name) {
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'project';
}

export function defaultPlugins() {
    return {
        law: { adapterId: 'docgraph-cli' },
        code: { adapterId: 'codegraph-cli' },
        memory: { adapterId: 'noop-memory' },
        jev: { adapterId: 'off', mode: 'off' },
        l3_route: { adapterId: 'off' },
        brain: { adapterId: 'deepseek-mcp' },
    };
}

function adapterEnabled(adapterId) {
    return adapterId && !String(adapterId).startsWith('noop') && adapterId !== 'off';
}

export function defaultProjectDraft({ displayName, id }) {
    const now = new Date().toISOString();
    const projectId = id || slugify(displayName);
    return {
        version: 1,
        id: projectId,
        displayName: displayName || projectId,
        status: 'draft',
        agentRepo: { root: '' },
        observe: { port: 8792 },
        hostMode: 'dual-ide',
        hostProfile: 'cursor-superset',
        plugins: defaultPlugins(),
        createdAt: now,
        updatedAt: now,
        provisionedAt: null,
    };
}

export function listProjects(stateDir) {
    const dir = projectsDir(stateDir);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function loadProject(stateDir, id) {
    const fp = projectFile(stateDir, id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

export function saveProject(stateDir, doc) {
    fs.mkdirSync(projectsDir(stateDir), { recursive: true });
    doc.updatedAt = new Date().toISOString();
    writeJsonAtomic(projectFile(stateDir, doc.id), doc);
    return doc;
}

/** Id = slug từ tên, cố định sau khi tạo (không đổi). */
export function createProject(stateDir, { displayName }) {
    const name = String(displayName || '').trim();
    if (!name) throw new Error('displayName required');
    const baseId = slugify(name);
    let projectId = baseId;
    let n = 0;
    while (loadProject(stateDir, projectId)) {
        n += 1;
        projectId = `${baseId}-${n}`;
    }
    const doc = defaultProjectDraft({ displayName: name, id: projectId });
    return saveProject(stateDir, doc);
}

function loadPluginCatalog(profilesDir) {
    const fp = path.join(profilesDir, 'plugin-catalog.json');
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
        return null;
    }
}

export function deepMergePolicyObjects(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [key, val] of Object.entries(patch)) {
        if (
            val &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            out[key] &&
            typeof out[key] === 'object' &&
            !Array.isArray(out[key])
        ) {
            out[key] = deepMergePolicyObjects(out[key], val);
        } else {
            out[key] = val;
        }
    }
    return out;
}

export function policyPatchesFromCatalog(plugins, catalog) {
    if (!catalog?.groups || !plugins) return {};
    let patch = {};
    for (const group of catalog.groups) {
        for (const slot of group.slots || []) {
            const state = plugins[slot.id];
            const adapterId = state?.adapterId;
            if (!adapterId) continue;
            const opt = (slot.options || []).find((o) => o.id === adapterId);
            if (opt?.policyPatch) {
                patch = deepMergePolicyObjects(patch, opt.policyPatch);
            }
        }
    }
    return patch;
}

/** Merge plugin toggles into decision-policy profile shape. */
export function policyFromProject(project, profileJson, catalog = null) {
    const policy = structuredClone(profileJson);
    const p = project.plugins || {};
    const jevMode =
        p.jev?.mode ||
        (p.jev?.adapterId === 'jev-typesafe-active' ? 'active' : null) ||
        (p.jev?.adapterId === 'jev-typesafe-shadow' ? 'shadow' : null) ||
        (p.jev?.enabled ? p.jev.mode || 'shadow' : null) ||
        'off';
    policy.jev = { ...(policy.jev || {}), mode: jevMode };

    const memId = p.memory?.adapterId ?? (p.agentmemory?.enabled ? 'agentmemory-mcp' : 'noop-memory');
    const codeId = p.code?.adapterId ?? (p.codegraph?.enabled !== false ? 'codegraph-cli' : 'noop-code');
    const lawId = p.law?.adapterId ?? (p.docgraph?.enabled !== false ? 'docgraph-cli' : 'noop-law');

    if (policy.eso?.sources) {
        policy.eso.sources.memory = {
            ...(policy.eso.sources.memory || {}),
            enabled: adapterEnabled(memId),
            adapter: memId || 'noop-memory',
        };
        policy.eso.sources.code = {
            ...(policy.eso.sources.code || {}),
            enabled: adapterEnabled(codeId),
            adapter: codeId || 'noop-code',
        };
        policy.eso.sources.law = {
            ...(policy.eso.sources.law || {}),
            enabled: adapterEnabled(lawId),
            adapter: lawId || 'noop-law',
        };
    }
    const brainId = p.brain?.adapterId ?? (p.brain?.enabled !== false ? 'deepseek-mcp' : 'none');
    policy.harnessConsole = {
        brain: adapterEnabled(brainId) ? { adapterId: brainId } : { provider: 'none' },
    };
    const l3Id = p.l3_route?.adapterId ?? 'off';
    policy.fallback = {
        ...(policy.fallback || {}),
        l3_flash: l3Id === 'deepseek-flash-route',
    };

    const jevOnPartial = jevMode === 'active' || jevMode === 'shadow';
    policy.eso = {
        ...(policy.eso || {}),
        memoryFetch: adapterEnabled(memId),
        preflight: {
            ...(policy.eso?.preflight || {}),
            enabled: policy.eso?.preflight?.enabled !== false,
            jevOnPartial,
        },
    };
    if (jevMode === 'active' && policy.eso.mode === 'observe') {
        policy.eso.mode = 'hint';
    }

    if (catalog) {
        return deepMergePolicyObjects(policy, policyPatchesFromCatalog(p, catalog));
    }
    return policy;
}

/** Tenant file strategy per Console UX §6.1. */
export function tenantProvisionAction(relative, exists, force = false) {
    const r = String(relative || '').replace(/\\/g, '/');
    if (r === CONFIG_NAME || r.endsWith('/harness.config.json')) {
        if (!exists) return 'create-if-missing';
        // `harness.config.json` is fully derived (init profile is its only writer) yet
        // `create-if-missing` means a stale one can never be repaired — a schema change or
        // a wrong pointer is permanent without hand-editing, which §24 forbids. `force`
        // is the supported repair.
        return force ? 'write' : 'skip';
    }
    if (r === '.harness/decision-policy.json') {
        // Never force-written: the plan's keys are re-applied by merge (the wizard's
        // plugin/profile choices are authoritative), but operator keys the plan does not
        // define survive a merge and a forced rewrite would drop them.
        return exists ? 'merge' : 'create-if-missing';
    }
    if (r === '.harness/integrations.json') {
        return 'write';
    }
    return null;
}

/** Product path: full host pack only — superset (one IDE) or dual-ide (Cursor + Antigravity). */
export function resolveHostProfileIds(project) {
    const mode = project.hostMode ?? 'dual-ide';
    if (mode === 'dual-ide') {
        return ['cursor-superset', 'agents-superset'];
    }
    if (mode === 'superset') {
        const id = project.hostProfile ?? 'cursor-superset';
        if (id === 'none') {
            throw new Error('hostProfile "none" is not supported — use hostMode superset or dual-ide');
        }
        return [id];
    }
    throw new Error(`unknown hostMode: ${mode}`);
}

function mergePolicyPatch(policy, hostProfile) {
    if (!hostProfile?.policyPatch) return policy;
    let out = { ...policy, ...structuredClone(hostProfile.policyPatch) };
    if (hostProfile.policyPatch.eso && out.eso) {
        out.eso = { ...out.eso, ...hostProfile.policyPatch.eso };
        if (hostProfile.policyPatch.eso.preflight && out.eso.preflight) {
            out.eso.preflight = { ...out.eso.preflight, ...hostProfile.policyPatch.eso.preflight };
        }
    }
    return out;
}

function hooksJsonRelative(treeKey, tree) {
    const rel = tree.hooksJsonPath || `.${treeKey}/hooks.json`;
    return rel.replace(/\\/g, '/');
}

/** @param {string} relative */
export function provisionFileGroup(relative) {
    const r = String(relative || '').replace(/\\/g, '/');
    if (r.startsWith('.cursor/')) return 'cursor';
    if (r.startsWith('.agents/')) return 'agents';
    return 'tenant';
}

function hostPreviewFiles(root, hostProfile, hostProfileId, observePort) {
    const files = [
        {
            path: path.join(root, '.harness', 'sidecar.env'),
            relative: '.harness/sidecar.env',
            action: 'write',
            group: 'tenant',
            preview: {
                HARNESS_SIDECAR_URL: `http://127.0.0.1:${observePort}`,
            },
        },
        {
            path: path.join(root, '.harness', 'host-bootstrap.json'),
            relative: '.harness/host-bootstrap.json',
            action: 'write',
            group: 'tenant',
            preview: { profileIds: hostProfileId, note: 'written on provision' },
        },
    ];
    const trees = [
        ['cursor', hostProfile.cursor],
        ['agents', hostProfile.agents],
    ];
    // The host pack is installed once, not per IDE tree: one bundled dispatcher serves every
    // hook of every IDE, so adding an IDE no longer duplicates the implementation.
    files.push({
        path: path.join(root, HOST_PACK_REL),
        relative: `${HOST_PACK_REL}/`,
        action: 'write',
        group: 'host-pack',
        preview: { note: 'bundled standalone hooks — no path back to the product checkout' },
    });
    for (const [treeKey, tree] of trees) {
        if (!tree) continue;
        const hooksJson = hooksJsonRelative(treeKey, tree);
        files.push({
            path: path.join(root, hooksJson),
            relative: hooksJson,
            action: 'merge',
            group: treeKey,
            preview: tree.merge ?? {},
        });
        if (tree.sessionDir) {
            const sessionPreflight = path.join(tree.sessionDir, '.eso-preflight.json').replace(/\\/g, '/');
            files.push({
                path: path.join(root, sessionPreflight),
                relative: sessionPreflight,
                action: 'runtime',
                group: treeKey,
                preview: {
                    note: 'written on beforeSubmitPrompt when observe sidecar is up',
                },
            });
        }
    }
    return files;
}

/**
 * Files that provision will create or skip if present.
 * @param {object} project
 * @param {string} profilesDir
 * @param {string} tenantsRegistryPath
 * @param {{ force?: boolean }} [opts] `force` rewrites a stale `harness.config.json`
 */
export function buildProvisionPlan(project, profilesDir, tenantsRegistryPath, opts = {}) {
    const force = opts.force === true;
    const rawRoot = String(project.agentRepo?.root || '').trim();
    if (!rawRoot) {
        throw new Error(
            'agentRepo.root is required — set the consumer repo in Console (Projects → project → Agent repo root). ' +
                'Refusing to fall back to the current working directory (that used to make the harness-eso checkout itself the consumer).',
        );
    }
    const root = resolveAgentRepoPath(path.resolve(rawRoot));
    // A consumer is a repo that USES the harness; provisioning the product repo would
    // write host hooks into the very repo that ships them.
    const esoRoot = path.resolve(path.dirname(profilesDir));
    if (root === esoRoot || root.startsWith(`${esoRoot}${path.sep}`)) {
        throw new Error(
            `agentRepo.root must be a consumer repo, not the harness-eso product repo (${esoRoot}). ` +
                'Pick a repo outside harness-eso, e.g. ~/Workspaces/x79.',
        );
    }
    const profilePath = path.join(profilesDir, 'generic-eso.json');
    const profile = fs.existsSync(profilePath)
        ? JSON.parse(fs.readFileSync(profilePath, 'utf8'))
        : { version: 1, eso: { enabled: true, mode: 'observe' } };
    const hostProfileIds = resolveHostProfileIds(project);
    const hostProfiles = hostProfileIds.map((id) => {
        const hp = loadHostProfile(profilesDir, id);
        if (!hp) throw new Error(`host profile missing: ${id}`);
        return hp;
    });
    const catalog = loadPluginCatalog(profilesDir);
    let policy = policyFromProject(project, profile, catalog);
    for (const hp of hostProfiles) {
        policy = mergePolicyPatch(policy, hp);
    }

    const harnessConfig = {
        version: 1,
        project: { id: project.id, displayName: project.displayName },
        tracking: { enabled: true, sentinelPath: '.harness/DISABLED' },
        storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        server: { host: '127.0.0.1', port: project.observe?.port || 8792 },
        ingest: {
            pollMs: 2000,
            harnesses: [
                { id: 'cursor', tree: '.cursor', shape: 'cursor', spine: 'jsonl-transcript' },
                { id: 'agents', tree: '.agents', shape: 'antigravity', spine: 'jsonl-transcript' },
            ],
        },
        // Written in `~` form, not as an absolute host path. This lands in a file the operator may
        // commit, so it must not encode one machine's home directory — and `loadConfig` expands `~`
        // when it reads the registry back.
        tenancy: { mode: 'isolated', registry: portableStatePath(tenantsRegistryPath) },
        integrations: project.plugins,
    };

    const harnessConfigPath = path.join(root, CONFIG_NAME);
    const policyPath = path.join(root, '.harness', 'decision-policy.json');
    const integrationsPath = path.join(root, '.harness', 'integrations.json');

    const files = [
        {
            path: harnessConfigPath,
            relative: CONFIG_NAME,
            action: tenantProvisionAction(CONFIG_NAME, fs.existsSync(harnessConfigPath), force),
            group: 'tenant',
            preview: harnessConfig,
        },
        {
            path: policyPath,
            relative: '.harness/decision-policy.json',
            action: tenantProvisionAction('.harness/decision-policy.json', fs.existsSync(policyPath)),
            group: 'tenant',
            preview: policy,
        },
        {
            path: integrationsPath,
            relative: '.harness/integrations.json',
            action: tenantProvisionAction('.harness/integrations.json', fs.existsSync(integrationsPath)),
            group: 'tenant',
            preview: project.plugins,
        },
    ];

    const observePort = project.observe?.port || 8792;
    const combinedHost = {
        cursor: hostProfiles.find((p) => p.cursor)?.cursor,
        agents: hostProfiles.find((p) => p.agents)?.agents,
    };
    files.push(...hostPreviewFiles(root, combinedHost, hostProfileIds.join('+'), observePort));

    return { root, files, project, hostProfileIds, hostProfiles };
}
