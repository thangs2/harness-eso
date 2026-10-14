export type ObserveRefreshReason = 'ingest' | 'live' | 'toggle' | 'connected';

type Listener = (reason: ObserveRefreshReason) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

export function subscribeObserveRefresh(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function emit(reason: ObserveRefreshReason) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        for (const fn of listeners) fn(reason);
    }, 150);
}

export function connectObserveSse(): () => void {
    if (typeof EventSource === 'undefined') return () => {};
    if (source) return () => {};

    source = new EventSource('/events');

    source.onopen = () => emit('connected');

    source.addEventListener('live', () => emit('live'));

    source.onmessage = (ev) => {
        try {
            const data = JSON.parse(ev.data) as { type?: string };
            if (data.type === 'ingest' || data.type === 'toggle') {
                emit(data.type);
            }
        } catch {
            /* ignore malformed frames */
        }
    };

    source.onerror = () => {
        source?.close();
        source = null;
    };

    return () => {
        source?.close();
        source = null;
    };
}
