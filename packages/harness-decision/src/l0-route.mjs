/**
 * L0 — path/stem heuristics until route-graph ships (W3+).
 * @param {import('./decision-types.mjs').DecisionEvent} event
 */
export function inferBucketFromEvent(event) {
    const paths = event.touchedPaths || [];
    const stem = String(event.userQueryStem || '').toLowerCase();
    const blob = [...paths, stem].join(' ').toLowerCase();

    if (/backend\/|dotnet|\.cs\b|abp|entityframework|postgres|mu-bible|nestjs|mongodb/i.test(blob)) return 'backend';
    if (/frontend\/|apps\/web|fe-app|fe-lib|react|\.tsx?\b|angular|\.component\./i.test(blob)) return 'frontend';
    if (/tools\/|harness|scripts\/|decision-facade|eso/i.test(blob)) return 'tools';
    if (/sdlc\/|docs\/|documents?\/|document\/harness/i.test(blob)) return 'docs';
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
