/**
 * L0 — path/stem heuristics until route-graph ships (W3+).
 * @param {import('./decision-types.mjs').DecisionEvent} event
 */
export function inferBucketFromEvent(event) {
    const paths = event.touchedPaths || [];
    const stem = String(event.userQueryStem || '').toLowerCase();
    const blob = [...paths, stem].join(' ').toLowerCase();

    if (/backend\/mu-|mu-bible|nestjs|mongodb/.test(blob)) return 'backend';
    if (/frontend\/|angular|\.component\./.test(blob)) return 'frontend';
    if (/tools\/harness|harness-eso|decision-facade|eso/.test(blob)) return 'tools';
    if (/sdlc\/|document\/harness/.test(blob)) return 'docs';
    if (paths.length) return 'general';
    return 'root';
}

/**
 * @param {import('./decision-types.mjs').DecisionEvent} event
 * @param {object} _policy
 */
export function resolveL0Route(event, _policy) {
    if (event.hookMeta?.forceAmbiguous) {
        return {
            outcome: 'tie',
            tie: true,
            route: { ambiguous: true },
            candidates: [
                { dirId: 'dir:backend', bucket: 'backend', score: 10 },
                { dirId: 'dir:frontend', bucket: 'frontend', score: 9 },
            ],
        };
    }
    const bucket = inferBucketFromEvent(event);
    const dirId = `rule:${bucket}`;
    return {
        outcome: 'winner',
        tie: false,
        winner: { dirId, bucket, score: 10, confidence: 0.85 },
        route: { winnerId: dirId, bucket, ambiguous: false },
        candidates: [{ dirId, bucket, score: 10 }],
    };
}
