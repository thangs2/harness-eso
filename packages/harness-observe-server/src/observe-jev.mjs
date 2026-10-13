/** Minimal JEV helpers (x79 decision-facade agent-hint parity). */

export function parseJevRouteBucket(jevResponseJson) {
    if (!jevResponseJson) return null;
    try {
        const env = JSON.parse(jevResponseJson);
        return env?.enforce?.bucket ?? env?.parsed?.option ?? null;
    } catch {
        return null;
    }
}
