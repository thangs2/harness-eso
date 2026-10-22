import type {
    ApiVersion,
    CallListResponse,
    ConfigureAddResult,
    DecisionFlowVm,
    DecisionListResponse,
    GateEventListResponse,
    GateSummaryResponse,
    HealthResponse,
    IngestRunReport,
    IngestStatus,
    RequestDetailResponse,
    RequestListResponse,
    RouteGraphDocument,
    TenantInfo,
    ToggleState,
    WorkspaceInfo,
} from './types';

export interface FetchRequestsParams {
    limit?: number;
    offset?: number;
    conversationId?: string;
    status?: string;
    hasFailures?: boolean;
    q?: string;
    from?: string;
    to?: string;
    ide?: string;
}

async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        throw new Error(`${path} → ${res.status}`);
    }
    return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        throw new Error(`${path} → ${res.status}`);
    }
    return res.json() as Promise<T>;
}

export function fetchApiVersion() {
    return getJson<ApiVersion>('/api/version');
}

export function fetchRequests(params?: FetchRequestsParams) {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    if (params?.conversationId) q.set('conversationId', params.conversationId);
    if (params?.status) q.set('status', params.status);
    if (params?.hasFailures) q.set('hasFailures', '1');
    if (params?.q) q.set('q', params.q);
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);
    if (params?.ide) q.set('ide', params.ide);
    const suffix = q.toString() ? `?${q}` : '';
    return getJson<RequestListResponse>(`/api/requests${suffix}`);
}

export function fetchDecisionFlow(params: { requestId?: string; conversationId?: string; limit?: number }) {
    const q = new URLSearchParams();
    if (params.requestId) q.set('requestId', params.requestId);
    if (params.conversationId) q.set('conversationId', params.conversationId);
    if (params.limit != null) q.set('limit', String(params.limit));
    return getJson<DecisionFlowVm>(`/api/decision-flow?${q}`);
}

export async function fetchRouteGraph(): Promise<RouteGraphDocument> {
    const res = await fetch('/api/route/graph.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error || `route graph → ${res.status}`;
        throw new Error(msg);
    }
    return res.json() as Promise<RouteGraphDocument>;
}

export function fetchRequestDetail(id: string) {
    return getJson<RequestDetailResponse>(`/api/requests/${encodeURIComponent(id)}`);
}

export function fetchTenant() {
    return getJson<TenantInfo>('/api/tenant');
}

export function fetchHealth() {
    return getJson<HealthResponse>('/health');
}

export function fetchIngestStatus() {
    return getJson<IngestStatus>('/api/ingest/status');
}

export function fetchToggleState() {
    return getJson<ToggleState>('/api/toggle');
}

export function postToggle(enabled: boolean) {
    return postJson<ToggleState>('/api/toggle', { enabled });
}

export function postIngestRun(force = false) {
    const q = force ? '?force=1' : '';
    return postJson<IngestRunReport>(`/api/ingest/run${q}`);
}

export function fetchCalls(params?: { limit?: number; offset?: number }) {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const suffix = q.toString() ? `?${q}` : '';
    return getJson<CallListResponse>(`/api/calls${suffix}`);
}

export function fetchWorkspace() {
    return getJson<WorkspaceInfo>('/api/workspace');
}

export function postWorkspaceAdd(body: {
    root: string;
    id?: string;
    displayName?: string;
    port?: number;
    profile?: string;
}) {
    return postJson<ConfigureAddResult>('/api/workspace/projects', body);
}

export function postWorkspaceUse(id: string) {
    return postJson<{ ok: boolean; defaultProjectId: string; needsObserveRestart?: boolean }>(
        '/api/workspace/use',
        { id },
    );
}

export function fetchDecisions(params?: { limit?: number; offset?: number }) {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const suffix = q.toString() ? `?${q}` : '';
    return getJson<DecisionListResponse>(`/api/decisions${suffix}`);
}

export function fetchGateEvents(params?: { limit?: number; kind?: string; tool?: string }) {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.kind) q.set('kind', params.kind);
    if (params?.tool) q.set('tool', params.tool);
    const suffix = q.toString() ? `?${q}` : '';
    return getJson<GateEventListResponse>(`/api/gate/events${suffix}`);
}

export function fetchGateSummary() {
    return getJson<GateSummaryResponse>('/api/gate/summary');
}
