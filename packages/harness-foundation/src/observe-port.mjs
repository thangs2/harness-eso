/**
 * One resolver for the observe port (invariant A1).
 *
 * The port a consumer's Observatory listens on is a **property of the project**, recorded once in
 * `~/.harness/workspace.json`. It used to be written down in five more places — the Console project
 * document, `harness.config.json`, `sidecar.env`, the compose project name and a `|| 8792` fallback in
 * every call site — and those copies disagreed: `baplatform` read `8793` from the workspace and `8792`
 * from its Console document, so `deploy.sh` brought up x79's stack under baplatform's name.
 *
 * Two rules follow, and everything else in this repo is expected to obey them:
 *
 *   - **A port is claimed, not defaulted.** `claimObservePort` returns the port already recorded for
 *     a project, or the lowest free one. No call site decides `8792` on its own.
 *   - **A port conflict is loud.** Two projects may not own the same host port, because compose would
 *     bind one stack and silently serve the other project's container.
 *
 * The compose project name is deliberately **not** derived from the port (see `observatory-cmd.mjs`):
 * a port is an entrance, a project id is an identity. Keying the stack by port meant that two
 * projects sharing one number shared one stack, and `down` for one tore down the other.
 */
import path from 'node:path';

/** First port considered when allocating. Ports below this are never handed out. */
export const OBSERVE_PORT_BASE = 8792;

/**
 * The port the Observatory server binds **inside** its container.
 *
 * Separate from `OBSERVE_PORT_BASE` on purpose, and the two used to be the same number. A host port
 * and an in-container port answer different questions — "which entrance does this project own" and
 * "where does the process listen" — and sharing one value made `docker ps` read as four stacks all
 * announcing port 8792, which is exactly the confusion a per-project port was supposed to remove.
 * The container port is a constant for every project: one image, N host ports.
 *
 * Changing it is a compose-level change (mapping, healthcheck, the image's own `CMD`), not a consumer
 * setting — no consumer should ever need to know this number.
 */
export const OBSERVE_CONTAINER_PORT = 8790;

/** How far the allocator will search before giving up. */
const OBSERVE_PORT_SPAN = 200;

/**
 * Normalise a declared port. Returns `null` for anything that is not a usable TCP port, so a caller
 * treats a corrupted record as "unknown" instead of silently adopting `NaN` or `0`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizePort(value) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
    return n;
}

/**
 * Ports already owned by the workspace, excluding one project (the one asking).
 *
 * @param {{ projects?: Array<{ id: string, port?: number|null, root?: string, rootHost?: string }> }} workspace
 * @param {string} [exceptId]
 * @returns {Map<string, number>}
 */
export function portsInUse(workspace, exceptId = '') {
    const out = new Map();
    for (const p of workspace?.projects ?? []) {
        if (!p?.id || p.id === exceptId) continue;
        const port = normalizePort(p.port);
        if (port !== null) out.set(p.id, port);
    }
    return out;
}

/**
 * The port a project owns: recorded if present, otherwise the lowest free one.
 *
 * Allocation is stable because the result is meant to be written back into the workspace — calling it
 * twice before that write returns the same answer, and calling it after returns the stored port.
 *
 * @param {{ projects?: Array<object> }} workspace
 * @param {string} projectId
 * @param {{ preferred?: number }} [opts] an operator's explicit wish; still checked for conflicts
 */
export function claimObservePort(workspace, projectId, opts = {}) {
    const projects = workspace?.projects ?? [];
    const own = projects.find((p) => p.id === projectId);
    const ownPort = normalizePort(own?.port ?? own?.hostPort ?? own?.rootHostPort);
    if (ownPort !== null) return ownPort;

    const inUse = portsInUse(workspace, projectId);
    const taken = new Set(inUse.values());

    const preferred = normalizePort(opts.preferred);
    if (preferred !== null && !taken.has(preferred)) return preferred;

    for (let port = OBSERVE_PORT_BASE; port < OBSERVE_PORT_BASE + OBSERVE_PORT_SPAN; port += 1) {
        if (!taken.has(port)) return port;
    }
    throw new Error(
        `no free observe port in ${OBSERVE_PORT_BASE}-${OBSERVE_PORT_BASE + OBSERVE_PORT_SPAN - 1} — ` +
            'free one in the Console Projects tab or with `harnessctl configure list`',
    );
}

/**
 * Throw when `projectId` would bind a port another project already owns.
 *
 * The error names the owner and both roots: the operator failure this replaces was a compose stack
 * that came up healthy while serving a different consumer, which no health check could detect.
 *
 * @param {{ projects?: Array<object> }} workspace
 * @param {string} projectId
 * @param {number|string} port
 */
export function assertPortAvailable(workspace, projectId, port) {
    const wanted = normalizePort(port);
    if (wanted === null) {
        throw new Error(`observe port for ${projectId} is not a valid TCP port: ${String(port)}`);
    }
    for (const [id, owned] of portsInUse(workspace, projectId)) {
        if (owned !== wanted) continue;
        const root = (workspace.projects ?? []).find((p) => p.id === id)?.rootHost ?? '';
        throw new Error(
            `observe port ${wanted} is already owned by project "${id}"${root ? ` (${root})` : ''} — ` +
                `pick another port for "${projectId}" (the Console Projects tab, or --port)`,
        );
    }
    return wanted;
}

/**
 * Record a project's port in the workspace, allocating it on first use.
 *
 * Both registries are updated by the caller that owns them (`workspace.json` here, the Console
 * document by `project-registry.mjs`); this function is only the workspace half, because it must stay
 * importable from a process that has no product state mounted.
 *
 * @param {{ projects?: Array<object> }} workspace mutated in place
 * @param {string} projectId
 * @param {{ preferred?: number }} [opts]
 * @returns {number} the owned port
 */
export function assignObservePort(workspace, projectId, opts = {}) {
    const port = claimObservePort(workspace, projectId, opts);
    const row = (workspace?.projects ?? []).find((p) => p.id === projectId);
    if (row) row.port = port;
    return port;
}

/**
 * The base URL an operator or the Console should call for a project's Observatory.
 *
 * `publicHost` exists for the containerised Console, which reaches the host through
 * `host.docker.internal` rather than `127.0.0.1`. Passing it is a transport decision, not a port
 * decision — the port still comes from the workspace.
 *
 * @param {{ projects?: Array<object> }} workspace
 * @param {string} projectId
 * @param {{ publicHost?: string }} [opts]
 */
export function observeUrlFor(workspace, projectId, opts = {}) {
    const port = claimObservePort(workspace, projectId);
    const host = opts.publicHost || '127.0.0.1';
    return `http://${host}:${port}`;
}

/**
 * Identity of a project's compose stack. Keyed by project id, never by port.
 *
 * @param {string} projectId
 */
export function composeProjectName(projectId) {
    const id = String(projectId ?? '').trim();
    if (!id) throw new Error('composeProjectName requires a project id');
    return `harness-observatory-${id.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/**
 * Locate a project by the directory a command was run from. Used by the CLI's cwd fallback so the
 * answer is the same one `harnessctl observatory --project <id>` would give.
 *
 * @param {{ projects?: Array<object> }} workspace
 * @param {string} cwd
 */
export function projectIdByRoot(workspace, cwd) {
    const abs = path.resolve(cwd);
    const hit = (workspace?.projects ?? []).find((p) => {
        const r1 = p?.root ? path.resolve(p.root) : '';
        const r2 = p?.rootHost ? path.resolve(p.rootHost) : '';
        return r1 === abs || r2 === abs;
    });
    return hit?.id ?? null;
}
