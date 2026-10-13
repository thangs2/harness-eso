/**
 * Collapse a full host pack status into the verdict a list view needs.
 *
 * The full status (per-hook probe results, every file checksum, per-tree entry counts) is for
 * `harness host-pack status`. A project list only needs to answer "is this consumer's guard layer
 * working", and — when it is not — why.
 *
 * Split out of the server module so the mapping is testable without starting an HTTP server. The
 * distinction it encodes is the point: `missing`/`broken` mean the consumer is **not** being
 * guarded, while `outdated`/`unwired` mean it is guarded but not as intended. Collapsing those into
 * one "bad" state would hide the difference between "no protection" and "protection you should
 * upgrade".
 *
 * @param {object} status result of `hostPackStatus(root)`
 * @returns {{ state: 'ok'|'missing'|'broken'|'outdated'|'unwired'|'error', detail?: string, version?: string, trees?: number }}
 */
export function summarizeHostPack(status) {
    if (!status?.installed) {
        return { state: 'missing', detail: status?.reason || 'host pack not installed' };
    }
    if (!status.ok) {
        return { state: 'broken', detail: `integrity: ${(status.corrupt || []).join(', ')}` };
    }
    const v = status.verification;
    if (v && v.ok === false) {
        return { state: 'broken', detail: `verification: ${(v.failures || []).join(', ')}` };
    }
    if (status.outdated) {
        return { state: 'outdated', detail: `installed ${status.version}, build ${status.buildVersion}` };
    }
    if (!status.trees?.length) {
        return { state: 'unwired', detail: 'pack installed but no IDE tree is wired' };
    }
    return { state: 'ok', version: status.version, trees: status.trees.length };
}
