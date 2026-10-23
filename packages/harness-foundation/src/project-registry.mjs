import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_NAME } from './repo-root.mjs';
import { claimObservePort, normalizePort } from './observe-port.mjs';
import {
    addProjectEntry,
    loadWorkspace,
    portableStatePath,
    resolveAgentRepoPath,
    updateProjectEntry,
} from './workspace-store.mjs';
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

/*
 * Project documents live in `workspace.json` (see `workspace-store.mjs`, registry v2). These three
 * names are kept because every caller already speaks them; they are now thin views over one file,
 * which is the point — there is no `projects/<id>.json` left to disagree with the workspace.
 */

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
        /*
         * `null`, not `8792`. A draft has not claimed a port yet — the project id only becomes the
         * owner of one when it is registered in the workspace, and `claimObservePort` is the only
         * place that decides which. Writing a default here created a second, disagreeing copy of the
         * port (`projects/baplatform.json` said 8792 while `workspace.json` said 8793).
         */
        observe: { port: null },
        hostMode: 'dual-ide',
        hostProfile: 'cursor-superset',
        plugins: defaultPlugins(),
        createdAt: now,
        updatedAt: now,
        provisionedAt: null,
    };
}

/** Every project, newest activity first. `stateDir` is accepted for call-site compatibility. */
export function listProjects() {
    return [...loadWorkspace().projects].sort((a, b) =>
        String(a.updatedAt ?? '') < String(b.updatedAt ?? '') ? 1 : -1,
    );
}

export function loadProject(_stateDir, id) {
    return loadWorkspace().projects.find((p) => p.id === id) ?? null;
}

/**
 * Persist the parts of a project document that are not registry columns.
 *
 * The registry row already holds id/displayName/root/port/profile; this writes the rest (status,
 * plugins, hostMode, observe metadata) into the same entry. A caller spreading a whole document is
 * still safe — the fields the row owns win, because the port resolver is the only decider.
 */
export function saveProject(_stateDir, doc) {
    if (!doc?.id) throw new Error('saveProject requires a project id');
    const patch = { ...doc };
    delete patch.root;
    delete patch.rootHost;
    return updateProjectEntry(doc.id, patch);
}

/** Id = slug từ tên, cố định sau khi tạo (không đổi). */
export function createProject(stateDir, { displayName, port = null, root = '', portSource = null }) {
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
    /*
     * A port is not invented here (that used to be `observe: { port: 8792 }`). The Console passes the
     * port it claimed in the workspace, so the document records the same number the CLI and the
     * compose stack use. `portSource` names where it came from, because a mismatch between two
     * registries is exactly what made baplatform serve on x79's stack — an unexplained number should
     * be visible in the record rather than inferred later.
     */
    doc.observe = { port: normalizePort(port) };
    doc.agentRepo = { root: String(root || '') };
    doc.root = String(root || '');
    doc.rootHost = String(root || '');
    doc.profile = 'generic-eso';
    if (portSource) doc.observe.source = portSource;
    return addProjectEntry(doc);
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

/** Project file strategy per Console UX §6.1. */
export function provisionAction(relative, exists, force = false) {
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
    if (mode === 'all-ide' || mode === 'tri-ide') {
        return ['cursor-superset', 'agents-superset', 'claude-superset'];
    }
    if (mode === 'claude') {
        return ['claude-superset'];
    }
    if (mode === 'superset') {
        const id = project.hostProfile ?? 'cursor-superset';
        if (id === 'none') {
            throw new Error('hostProfile "none" is not supported — use hostMode superset, dual-ide, claude or all-ide');
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
    return 'project';
}

function hostPreviewFiles(root, hostProfile, hostProfileId, observePort) {
    const files = [
        {
            path: path.join(root, '.harness', 'sidecar.env'),
            relative: '.harness/sidecar.env',
            action: 'write',
            group: 'project',
            preview: {
                HARNESS_SIDECAR_URL: `http://127.0.0.1:${observePort}`,
            },
        },
        {
            path: path.join(root, '.harness', 'host-bootstrap.json'),
            relative: '.harness/host-bootstrap.json',
            action: 'write',
            group: 'project',
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
 * @param {string} registryPath
 * @param {{ force?: boolean, observePort?: number }} [opts] `force` rewrites a stale `harness.config.json`;
 *   `observePort` pins the port instead of claiming one from the workspace
 */
export function buildProvisionPlan(project, profilesDir, registryPath, opts = {}) {
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

    /*
     * The port comes from the workspace record, which is the only registry that owns it. This used to
     * be `project.observe?.port || 8792` — so a project document that had never been reconciled with
     * the workspace wrote the wrong number into `harness.config.json`, `sidecar.env` and
     * `host-bootstrap.json`, and the consumer's own tools then called the wrong Observatory.
     */
    const observePort = normalizePort(opts.observePort) ?? claimObservePort(loadWorkspace(), project.id, {
        preferred: project.observe?.port,
    });
    const harnessConfig = {
        version: 1,
        project: { id: project.id, displayName: project.displayName },
        tracking: { enabled: true, sentinelPath: '.harness/DISABLED' },
        storage: { driver: 'sqlite', sqlite: { path: '.harness/harness.db' } },
        server: { host: '127.0.0.1', port: observePort },
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
        registry: { mode: 'isolated', registry: portableStatePath(registryPath) },
        integrations: project.plugins,
    };

    const harnessConfigPath = path.join(root, CONFIG_NAME);
    const policyPath = path.join(root, '.harness', 'decision-policy.json');
    const integrationsPath = path.join(root, '.harness', 'integrations.json');

    const files = [
        {
            path: harnessConfigPath,
            relative: CONFIG_NAME,
            action: provisionAction(CONFIG_NAME, fs.existsSync(harnessConfigPath), force),
            group: 'project',
            preview: harnessConfig,
        },
        {
            path: policyPath,
            relative: '.harness/decision-policy.json',
            action: provisionAction('.harness/decision-policy.json', fs.existsSync(policyPath)),
            group: 'project',
            preview: policy,
        },
        {
            path: integrationsPath,
            relative: '.harness/integrations.json',
            action: provisionAction('.harness/integrations.json', fs.existsSync(integrationsPath)),
            group: 'project',
            preview: project.plugins,
        },
    ];

    const combinedHost = {
        cursor: hostProfiles.find((p) => p.cursor)?.cursor,
        agents: hostProfiles.find((p) => p.agents)?.agents,
    };
    files.push(...hostPreviewFiles(root, combinedHost, hostProfileIds.join('+'), observePort));

    return { root, files, project, hostProfileIds, hostProfiles, observePort };
}
