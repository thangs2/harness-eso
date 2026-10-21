/**
 * DSH session memory as an ESO **native** provider.
 *
 * Why a factory instead of a direct import
 * ----------------------------------------
 * This package must stay dependency-free: the Cordis plugin owns the DSH context, and importing
 * `@deepseek-ai/dsh-session-query` here would pin the shim to one DSH prerelease. The plugin passes
 * its own query function in; the provider stays a pure adapter that a test can drive.
 *
 * What "native" buys (RFC 18 §3.3)
 * --------------------------------
 * The host already holds the session log, so recall has no extra service, no network and no auth.
 * Its ceiling is deliberately below 1: a session search answers "what did we do", not "what is the
 * contract", so it must not let `MEMORY_PRIOR` look fully satisfied on its own.
 */

/**
 * @param {{
 *   searchEvents: (query: { text: string, limit: number, sessionId?: string, cwd?: string }) =>
 *     Promise<Array<{ text?: string, snippet?: string, score?: number, seq?: number, sessionId?: string }>>,
 *   id?: string,
 *   ceiling?: number,
 *   limit?: number,
 * }} options
 */
export function createDshSessionMemory(options = {}) {
    const { searchEvents, id = 'native:dsh-session', ceiling = 0.65, limit = 5 } = options;
    if (typeof searchEvents !== 'function') {
        throw new Error('createDshSessionMemory: searchEvents must be a function');
    }

    return {
        id,
        kinds: ['memory'],
        capability: 'native',
        ceiling,
        healthCheck() {
            return true;
        },
        async fetch(query, ctx = {}) {
            const text = String(query?.text ?? query?.query ?? query ?? '').trim();
            if (!text) return { snippets: [], trace: `${id}:skip-empty` };

            const hits = await searchEvents({
                text,
                limit,
                sessionId: ctx.conversationId ?? ctx.sessionId ?? undefined,
                cwd: ctx.root,
            });

            const snippets = (Array.isArray(hits) ? hits : [])
                .filter((hit) => hit && (hit.text || hit.snippet))
                .slice(0, limit)
                .map((hit) => ({
                    kind: 'memory',
                    text: hit.text ?? hit.snippet,
                    query: text,
                    meta: {
                        provider: id,
                        sessionId: hit.sessionId ?? null,
                        seq: hit.seq ?? null,
                    },
                    /*
                     * Provenance is what makes this evidence rather than a hint (RFC 18 P2). A
                     * session hit can always name the event it came from; if it cannot, it should
                     * not be scored as evidence later.
                     */
                    provenance: {
                        kind: 'session',
                        sessionId: hit.sessionId ?? null,
                        sessionSeq: hit.seq ?? null,
                    },
                    confidence: typeof hit.score === 'number' ? hit.score : null,
                }));

            return { snippets, trace: `${id}:${snippets.length}` };
        },
    };
}
