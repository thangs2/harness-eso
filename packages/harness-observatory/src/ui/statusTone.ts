export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

export function requestStatusTone(status: string | null | undefined): BadgeTone {
    const s = String(status || '').toLowerCase();
    if (!s) return 'neutral';
    if (s.includes('fail') || s.includes('error') || s.includes('cancel')) return 'danger';
    if (s.includes('run') || s.includes('progress') || s.includes('active') || s.includes('ingest')) {
        return 'warn';
    }
    if (
        s.includes('done') ||
        s.includes('complete') ||
        s.includes('success') ||
        s.includes('stop') ||
        s === 'ok'
    ) {
        return 'ok';
    }
    if (s.includes('pending') || s.includes('unknown')) return 'neutral';
    return 'info';
}

export function verdictTone(verdict: string | null | undefined): BadgeTone {
    const v = String(verdict || '').toLowerCase();
    if (!v || v === '—') return 'neutral';
    if (v.includes('sufficient') || v.includes('pass') || v.includes('allow')) return 'ok';
    if (v.includes('partial') || v.includes('warn') || v.includes('hil')) return 'warn';
    if (v.includes('insufficient') || v.includes('deny') || v.includes('block') || v.includes('jev_stop')) {
        return 'danger';
    }
    return 'info';
}

export function sufficiencyTone(level: string | undefined): BadgeTone {
    if (level === 'sufficient') return 'ok';
    if (level === 'partial') return 'warn';
    if (level === 'insufficient') return 'danger';
    return 'neutral';
}

/** Consent gate tone — `consent` is advisory, `deny` actually blocks. */
export function gateModeTone(gate: string | null | undefined): BadgeTone {
    if (gate === 'deny') return 'danger';
    if (gate === 'consent') return 'warn';
    if (gate === 'warn_only') return 'info';
    return 'neutral';
}

/** Operator choice state. `pending` means nobody has answered — not an error. */
export function consentOutcomeTone(outcome: string | null | undefined): BadgeTone {
    if (outcome === 'continue') return 'ok';
    if (outcome === 'stop') return 'danger';
    if (outcome === 'pending') return 'warn';
    return 'neutral';
}

export function checkStatusTone(status: string): BadgeTone {
    const s = status.toLowerCase();
    if (s.includes('pass') || s === 'ok') return 'ok';
    if (s.includes('fail') || s.includes('error')) return 'danger';
    if (s.includes('skip') || s.includes('warn')) return 'warn';
    return 'neutral';
}

/** Short label for table cells */
export function formatRelativeWhen(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        const now = Date.now();
        const diff = now - d.getTime();
        if (diff < 60_000) return 'just now';
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return iso;
    }
}

export function formatWhenFull(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

export function fmtTokens(n: number | null | undefined, estimated?: boolean): string {
    if (n == null || !Number.isFinite(n)) return '—';
    const s = n.toLocaleString();
    return estimated ? `~${s}` : s;
}

/**
 * Wall-clock length of a turn, e.g. "1m 18s".
 *
 * Lives here rather than in the header because the hero, the list and any future timeline
 * must agree on how a duration reads. Returns null when either bound is missing or the pair
 * is inverted — a negative duration is a data problem, not something to render as "0s".
 */
export function formatDuration(
    startIso: string | null | undefined,
    endIso: string | null | undefined,
): string | null {
    if (!startIso || !endIso) return null;
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}
