/** Frozen shapes from 15.observe-api-contract.md + 16.harness-observatory-spec.md §3 */

export type SufficiencyLevel = 'sufficient' | 'partial' | 'insufficient';

export interface EvidenceGap {
    id?: string;
    kind?: string;
    message?: string;
}

export interface RecoveryPlaybookStep {
    id?: string;
    label?: string;
    hint?: string;
}

export interface EsoSlice {
    sufficiency?: SufficiencyLevel | string;
    score?: number | null;
    gaps?: EvidenceGap[];
    recoveryPlaybook?: RecoveryPlaybookStep[];
}

export interface ConsentOutcome {
    outcome?: 'stop' | 'continue' | 'pending';
    at?: string;
    waiverId?: string;
}

export interface PreflightSlice {
    injectBrainBlock?: boolean;
    artifactPath?: string;
}

export interface PolicySnapshot {
    eso?: {
        mode?: string;
        enforceWrites?: string;
        /** ESO sufficiency bands — `score < T_low` is insufficient, `>= T_high` is sufficient. */
        thresholds?: { T_low?: number | null; T_high?: number | null };
        cognition?: {
            insufficientPromptGate?: 'warn_only' | 'consent' | 'deny';
        };
        preflight?: { jevOnPartial?: boolean };
    };
}

export interface RequestConsentVm {
    eso?: EsoSlice;
    consent?: ConsentOutcome;
    preflight?: PreflightSlice;
    policySnapshot?: PolicySnapshot;
}

export interface RequestListItem {
    id: string;
    generationId?: string | null;
    conversationId: string;
    boundaryIndex: number;
    userQuery: string;
    startedAt?: string | null;
    endedAt?: string | null;
    status: string;
    stopStatus?: string | null;
    decisionVerdict?: string | null;
    callCount?: number;
    toolCount?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    modelId?: string | null;
    hasFailures?: boolean | number;
    checksPass?: number;
    checksFail?: number;
    /** Output from emit_chars÷4 when hook tokens missing */
    tokensEstimated?: boolean;
    emitChars?: number | null;
    /** Originating IDE: 'cursor' | 'antigravity' | 'unknown' */
    ide?: string;
}

export interface FlowGraphVm {
    nodes?: Array<{
        id: string;
        combo?: string;
        style?: { x?: number; y?: number };
        data?: Record<string, unknown>;
    }>;
    edges?: Array<{ id?: string; source: string; target: string; data?: Record<string, unknown> }>;
    combos?: Array<{ id: string; data?: { label?: string } }>;
    highlights?: string[];
    width?: number;
    height?: number;
    legend?: string;
    title?: string;
    activeNodeCount?: number;
    activeEdgeCount?: number;
}

export interface DecisionLedgerRowVm {
    id: string;
    eventType?: string;
    jevMode?: string;
    resolverWinner?: string | null;
    enforcedVerdict?: string | null;
    jevSummary?: string | null;
    createdAt?: string;
}

export interface DecisionFlowVm {
    request?: {
        id?: string;
        conversationId?: string;
        boundaryIndex?: number;
        userQuery?: string;
        startedAt?: string;
    };
    decisions?: DecisionLedgerRowVm[];
    decisionsDisplay?: DecisionLedgerRowVm[];
    evidenceSufficiency?: {
        enforcedVerdict?: string;
        summary?: string;
    } | null;
    ingestNote?: string | null;
    graph?: FlowGraphVm | null;
    designGraph?: FlowGraphVm | null;
    sequenceGraph?: FlowGraphVm | null;
    mcpStats?: {
        flashBrain?: number;
        flashExecutor?: number;
        pro?: number;
        jev?: number;
    } | null;
    designRef?: string;
}

/**
 * Brain graph — `GET /api/brain/graph.json`. Server-owned contract: the server composes it from
 * the observe DB only (brain-graph-build.mjs), so `meta.omitted` is the honest answer for a layer
 * this deployment does not produce yet, and `meta.truncated` is the only way a cap may be shown.
 */
export type BrainKind = 'root' | 'area' | 'note' | 'skill' | 'tool' | 'run' | 'app';
export type BrainLayer = 'core' | 'memory' | 'skills' | 'runs' | 'apps';

export interface BrainNode {
    id: string;
    kind: BrainKind;
    layer: BrainLayer;
    label: string;
    area: string | null;
    /** Path as this *server* sees it — what the preview route opens. */
    path: string | null;
    /** Same file as the *host* saw it (Docker mount, otherwise identical to `path`). Display/copy this. */
    pathHost: string | null;
    /** Server verified it can open this node as a text file. False for directories and unmounted paths. */
    previewable: boolean;
    note: string | null;
    changed: string | null;
    degree: number;
    weight: number;
}

export interface BrainLink {
    s: string;
    t: string;
}

export interface BrainFileResponse {
    path: string;
    relativePath: string;
    bytes: number;
    shownBytes: number;
    truncated: boolean;
    text: string;
}

export interface BrainGraphDocument {
    version: number;
    nodes: BrainNode[];
    links: BrainLink[];
    legend?: string;
    meta: {
        builtAt: string;
        project: { id: string; label: string; rootPath: string };
        sources: { source: string; present: boolean; rows: number }[];
        omitted: { layer: string; reason: string }[];
        truncated: { kind: string; shown: number; total: number }[];
        limits: Record<string, number>;
    };
}

export interface RequestListResponse {
    items: RequestListItem[];
    page: { limit: number; offset: number; total: number };
}

export interface McpCallStatsRow {
    flashBrain?: number;
    flashExecutor?: number;
    proCount?: number;
    /**
     * The `ask_deepseek` smart router, whose tier the server derives from complexity keywords at call
     * time. Kept out of `proCount`/`flashExecutor` rather than guessed into one.
     */
    smartRouteCount?: number;
    /**
     * Jev decisions, not MCP calls: Jev is invoked over HTTP by the decision facade. Shown in the
     * same card because it is a per-turn model-call count, but labelled as decisions.
     */
    jevCount?: number;
    /** Brain tokens reported by the MCP server. Null (not 0) when nothing reported — see `brainUsageCalls`. */
    brainPromptTokens?: number | null;
    brainCompletionTokens?: number | null;
    brainCacheHitTokens?: number | null;
    brainReasoningTokens?: number | null;
    /** How many MCP calls actually reported usage, so a partial report is visible. */
    brainUsageCalls?: number;
    updatedAt?: string;
}

export interface RequestHeaderMetrics {
    callCount?: number;
    toolCount?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    modelId?: string | null;
    hasFailures?: boolean;
    /**
     * MCP **tool** calls (Jira, search, browser…) — a different quantity from the model calls in
     * `mcpCallStats`. Both travel over MCP and share nothing else: different counts, different costs.
     * Kept separate because labelling the model figure "MCP calls" read as the tool count.
     */
    mcpToolCalls?: number;
    mcpToolKinds?: number;
    mcpCallStats?: McpCallStatsRow | null;
}

export interface TokenSummary {
    input?: number | null;
    output?: number | null;
    cacheRead?: number | null;
    source?: string;
    estimated?: boolean;
    /**
     * Set when the transcript carried no token usage at all, so the input side is unknowable
     * rather than zero. The server uses `no_token_usage_in_transcript`.
     */
    inputUnavailable?: string | null;
}

export interface RequestDetailResponse extends RequestConsentVm {
    /** Consumer repo root — for promax-style relative paths in flow steps. */
    callerRootPath?: string;
    request?: Record<string, unknown>;
    requestMetrics?: RequestHeaderMetrics;
    mcpCallStats?: McpCallStatsRow | null;
    tokenSummary?: TokenSummary;
    stops?: Array<Record<string, unknown>>;
    evidence?: Record<string, unknown>;
    decisionFlow?: DecisionFlowVm | null;
    checks?: Array<{ checkId: string; status: string; heuristic?: boolean; detail?: string }>;
    tools?: Array<{ tool: string; count: number }>;
    files?: Array<{ path: string; reads: number; edits: number }>;
    llmCalls?: unknown[];
    evidenceNote?: string | null;
    /** Route-trace / hook rollup (observe-server VM extension). */
    events?: Array<{ eventType?: string; tool?: string; path?: string; hookAt?: string; command?: string }>;
    meta?: Record<string, unknown>;
    rules?: Array<{ ruleId?: string; attachedAt?: string }>;
    attached?: Array<{ type?: string; filePath?: string }>;
    conversation?: Record<string, unknown> | null;
    /** Rules/skills + tool trace (promax flow graph). */
    flowGraph?: FlowGraphVm | null;
}

export interface AggregateBucket {
    t: string;
    requests: number;
    llmCalls: number;
    tools: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    failures: number;
}

export interface AggregatesResponse {
    buckets: AggregateBucket[];
}

export interface WorkspaceProject {
    id: string;
    displayName: string;
    root: string;
    rootHost?: string;
    port: number;
    profile?: string;
}

export interface WorkspaceInfo {
    ok: boolean;
    defaultProjectId: string | null;
    projects: WorkspaceProject[];
    workspaceFile?: string;
}

export interface ConfigureAddResult {
    ok: boolean;
    projectId: string;
    consumerPath: string;
    serverUrl?: string;
    created?: { config: boolean; policy: boolean };
    error?: string;
}

export interface ProjectInfo {
    id: string;
    displayName: string;
    rootPath: string;
    enabled: boolean;
    server?: { host: string; port: number; url: string };
    counts?: { requests: number; calls: number; events: number; conversations: number };
}

export interface IngestSpineStatus {
    spineOk?: boolean;
    transcriptDir?: string | null;
    transcriptDirExists?: boolean;
    transcriptFiles?: number;
    cursorMount?: string | null;
    requestCount?: number;
    warnings?: string[];
}

export interface HealthResponse {
    ok: boolean;
    degraded?: boolean;
    enabled?: boolean;
    revision?: number;
    turns?: number;
    events?: number;
    uptimeSec?: number;
    clients?: number;
    ingestSpine?: IngestSpineStatus;
}

export interface IngestStatus {
    db?: string;
    dbExists?: boolean;
    enabled?: boolean;
    counts?: { requests: number; calls: number; events: number; conversations?: number };
    transcriptDir?: string | null;
    transcriptDirExists?: boolean;
    transcriptFiles?: number;
    cursorMount?: string | null;
    spineOk?: boolean;
    warnings?: string[];
}

export interface CallListItem {
    id: string;
    requestId?: string;
    userQuery?: string;
    requestStartedAt?: string;
    kind?: string;
    toolCount?: number;
    preview?: string;
}

export interface CallListResponse {
    items: CallListItem[];
    page: { limit: number; offset: number; total: number };
}

export interface DecisionListItem {
    id: string;
    requestId?: string;
    userQuery?: string;
    eventType: string;
    enforcedVerdict?: string | null;
    resolverWinner?: string | null;
    createdAt?: string;
}

export interface DecisionListResponse {
    items: DecisionListItem[];
    page: { limit: number; offset: number; total: number };
}

export interface IngestRunReport {
    ok: boolean;
    reason?: string;
    counts?: { requests: number; calls: number; events: number };
}

export interface ToggleState {
    enabled: boolean;
}

export interface ApiVersion {
    apiVersion: string;
    package: string;
    serverVersion: string;
    openapi: string;
    startedAt: string;
}

/** One decision the runtime gate recorded (prompt rejection or denied tool call). */
export interface GateEvent {
    id: number;
    at: string | null;
    kind: string;
    host: string | null;
    event: string | null;
    tool: string | null;
    ref: string | null;
    detail: string | null;
    blockers: Array<{ source?: string | null; kind?: string | null; ref?: string | null; detail?: string | null }>;
    source_path: string;
    source_line_no: number;
}

export interface GateEventListResponse {
    items: GateEvent[];
    total: number;
    limit: number;
}

export interface GateSummaryResponse {
    byKind: Array<{ kind: string; n: number }>;
    byTool: Array<{ tool: string | null; n: number }>;
    byRef: Array<{ ref: string | null; n: number }>;
    latestAt: string | null;
    trailPath: string | null;
}
