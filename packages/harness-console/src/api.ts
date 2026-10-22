import embeddedCatalog from '../../../profiles/plugin-catalog.json';

/** Collapsed host pack verdict for a project row — see the console server's `summarizeHostPack`. */
export interface HostPackSummary {
    state: 'ok' | 'missing' | 'broken' | 'outdated' | 'unwired' | 'error';
    detail?: string;
    version?: string;
    trees?: number;
}

export interface HarnessProject {
    version: number;
    id: string;
    displayName: string;
    status: 'draft' | 'provisioned';
    hostPack?: HostPackSummary | null;
    agentRepo: { root: string };
    /** Port as recorded in `workspace.json` (`recorded` mirrors it), plus why if it disagrees. */
    observe: { port: number; recorded?: number; source?: string };
    /**
     * Non-null when a project document and the workspace disagree, or two projects own one port. The
     * server reports the workspace's value in `observe.port` either way; this field says the two
     * registries are not yet reconciled.
     */
    portConflict?: { document?: number; workspace?: number; owner?: string; detail: string } | null;
    hostMode?: 'dual-ide' | 'superset';
    hostProfile?: string;
    plugins: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    provisionedAt: string | null;
}

async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json() as Promise<T>;
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${path} → ${res.status}`);
    }
    return res.json() as Promise<T>;
}

export interface PluginCatalog {
    version: number;
    pipelineIntro?: { diagramId?: string; label?: string };
    groups: Array<{
        id: string;
        badge?: string;
        label: string;
        description?: string;
        diagramId?: string;
        slots: Array<{
            id: string;
            label: string;
            kind?: string;
            options: Array<{
                id: string;
                label: string;
                default?: boolean;
                custom?: boolean;
                mode?: string;
                hint?: string;
                hintDiagram?: string;
            }>;
            secrets?: {
                envFile: string;
                envVar: string;
                doc: string;
                note: string;
            };
        }>;
    }>;
}

function isPluginCatalog(data: unknown): data is PluginCatalog {
    return (
        typeof data === 'object' &&
        data !== null &&
        Array.isArray((data as PluginCatalog).groups)
    );
}

/** API first; nếu server cũ trả HTML → dùng catalog nhúng trong build. */
export async function fetchPluginCatalog(): Promise<{ catalog: PluginCatalog; source: 'api' | 'embedded' }> {
    try {
        const res = await fetch('/api/plugin-catalog', { headers: { Accept: 'application/json' } });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.includes('json')) {
            throw new Error(`catalog HTTP ${res.status}`);
        }
        const data = (await res.json()) as unknown;
        if (!isPluginCatalog(data)) throw new Error('catalog invalid JSON');
        return { catalog: data, source: 'api' };
    } catch {
        if (!isPluginCatalog(embeddedCatalog)) {
            throw new Error('embedded plugin catalog missing');
        }
        return { catalog: embeddedCatalog, source: 'embedded' };
    }
}

export function listProjects() {
    return getJson<{ ok: boolean; items: HarnessProject[] }>('/api/projects');
}

/**
 * The observe plane as the server resolves it: one Observatory per project, each on the port recorded
 * in `workspace.json`. The UI must read ports from here rather than assume `:8792` — a Console that
 * assumes one port can only manage one project, which is the bug this route exists to end.
 */
export interface ObservePortRow {
    id: string;
    displayName: string;
    root: string;
    port: number;
    observeUrl: string;
    defaultProject: boolean;
}

export function listObservePorts() {
    return getJson<{ ok: boolean; items: ObservePortRow[] }>('/api/observe-ports');
}

export function createProject(displayName: string) {
    return sendJson<{ ok: boolean; project: HarnessProject }>('/api/projects', 'POST', { displayName });
}

export function getProject(id: string) {
    return getJson<{ ok: boolean; project: HarnessProject }>(`/api/projects/${encodeURIComponent(id)}`);
}

export function patchProject(id: string, patch: Partial<HarnessProject>) {
    return sendJson<{ ok: boolean; project: HarnessProject }>(
        `/api/projects/${encodeURIComponent(id)}`,
        'PATCH',
        patch,
    );
}

export function previewProject(id: string) {
    return getJson<{
        ok: boolean;
        root: string;
        files: Array<{
            relative: string;
            action: string;
            exists: boolean;
            preview: unknown;
            group?: 'tenant' | 'cursor' | 'agents';
        }>;
    }>(`/api/projects/${encodeURIComponent(id)}/preview`);
}

export function provisionProject(id: string) {
    const path = `/api/projects/${encodeURIComponent(id)}/provision`;
    return sendJson<{ ok: boolean; files: unknown[]; observeUrl: string }>(path, 'POST');
}

/**
 * Rewrite the consumer's host side: hook bins, `hooks.json` (merged and de-duplicated),
 * `sidecar.env`, and `.harness/host-bootstrap.json` with a fresh `appliedAt`. Use after
 * editing host profiles, without re-running the tenant provision.
 *
 * `tenant: true` also rewrites the tenant anchor (`harness.config.json` + merge
 * `decision-policy.json`) — the repair path for an anchor that `create-if-missing` would
 * otherwise leave stale. Operator edits in `decision-policy.json` are preserved.
 */
export function reloadProjectHost(id: string, opts: { tenant?: boolean } = {}) {
    const path = `/api/projects/${encodeURIComponent(id)}/reload`;
    return sendJson<{
        ok: boolean;
        root: string;
        hostProfileIds: string[];
        tenantRefreshed: boolean;
        bootstrap: { appliedAt?: string };
        files: Array<{ relative: string; action?: string; status?: string }>;
    }>(path, 'POST', { tenant: opts.tenant === true });
}

export function fetchMeta() {
    return getJson<{
        ok: boolean;
        productStateDir: string;
        projectsDir: string;
        /** Agent workspace root to offer in the wizard — never the harness-eso checkout. */
        agentRootDefault?: string;
    }>('/api/meta');
}

export interface HostProfileSummary {
    id: string;
    label: string;
    description?: string;
    trees: string[];
    supersetFor: 'cursor' | 'agents' | null;
}

export function fetchHostProfiles() {
    return getJson<{ ok: boolean; items: HostProfileSummary[] }>('/api/host-profiles');
}

export type JevStatus = {
    ok: boolean;
    serverEnvKey: boolean;
    consumer: { envFileExists: boolean; keyConfigured: boolean; envPath?: string };
    ready: boolean;
};

export function fetchJevStatus(consumerRoot?: string) {
    const q = consumerRoot ? `?consumerRoot=${encodeURIComponent(consumerRoot)}` : '';
    return getJson<JevStatus>(`/api/jev/status${q}`);
}

export function smokeTestJev(body: { apiKey?: string }) {
    return sendJson<{
        ok: boolean;
        error?: string;
        message?: string;
        detail?: string;
        persisted: false;
    }>('/api/jev/smoke-test', 'POST', body);
}

export interface ConsentRecord {
    id: string;
    path: string;
    approvedBy: string;
    reason?: string;
    requestId?: string | null;
    at: string;
    expiresAt: string;
}

export interface ConsentResponse {
    ok: boolean;
    dir: string;
    live: ConsentRecord[];
    all: ConsentRecord[];
}

export function fetchConsent(projectId: string) {
    return getJson<ConsentResponse>(`/api/projects/${encodeURIComponent(projectId)}/consent`);
}

export function grantConsent(
    projectId: string,
    body: { path: string; reason?: string; ttlSeconds?: number; requestId?: string },
) {
    return sendJson<{ ok: boolean; record: ConsentRecord }>(
        `/api/projects/${encodeURIComponent(projectId)}/consent`,
        'POST',
        body,
    );
}

export function revokeConsent(projectId: string, target: { id?: string; path?: string }) {
    return sendJson<{ ok: boolean; revoked: number; active: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/consent`,
        'DELETE',
        target,
    );
}
