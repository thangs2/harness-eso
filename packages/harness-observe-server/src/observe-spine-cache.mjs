const SPINE_TTL_MS = Number(process.env.HARNESS_SPINE_CACHE_MS || 60_000);
const INGEST_STATUS_TTL_MS = Number(process.env.HARNESS_INGEST_STATUS_CACHE_MS || 30_000);

let spineEntry = { key: '', at: 0, data: null };
let ingestStatusEntry = { key: '', at: 0, data: null };

function cfgKey(cfg) {
    return `${cfg.root}|${cfg.ingest?.transcriptDir || ''}`;
}

export function getCachedTranscriptSpine(cfg, loadSpine) {
    const key = cfgKey(cfg);
    const now = Date.now();
    if (spineEntry.key === key && spineEntry.data && now - spineEntry.at < SPINE_TTL_MS) {
        return spineEntry.data;
    }
    const data = loadSpine();
    spineEntry = { key, at: now, data };
    return data;
}

export function invalidateObserveCaches() {
    spineEntry.at = 0;
    ingestStatusEntry.at = 0;
}

export function getCachedIngestStatus(cfg, loadFull) {
    const key = cfgKey(cfg);
    const now = Date.now();
    if (ingestStatusEntry.key === key && ingestStatusEntry.data && now - ingestStatusEntry.at < INGEST_STATUS_TTL_MS) {
        return ingestStatusEntry.data;
    }
    const data = loadFull();
    ingestStatusEntry = { key, at: now, data };
    return data;
}
