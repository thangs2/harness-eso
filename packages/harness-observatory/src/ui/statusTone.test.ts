import { describe, expect, it } from 'vitest';
import { fmtTokens, formatDuration, formatRelativeWhen } from './statusTone';

describe('formatDuration', () => {
    it('reads as a wall-clock length at every scale', () => {
        const t = '2026-10-12T13:15:00Z';
        expect(formatDuration(t, '2026-10-12T13:15:00.400Z')).toBe('400ms');
        expect(formatDuration(t, '2026-10-12T13:15:18Z')).toBe('18s');
        expect(formatDuration(t, '2026-10-12T13:16:18Z')).toBe('1m 18s');
        expect(formatDuration(t, '2026-10-12T13:15:00Z')).toBe('0ms');
        expect(formatDuration(t, '2026-10-12T14:15:00Z')).toBe('1h');
        expect(formatDuration(t, '2026-10-12T14:20:00Z')).toBe('1h 5m');
        // A whole number of minutes drops the empty seconds field.
        expect(formatDuration(t, '2026-10-12T13:17:00Z')).toBe('2m');
    });

    it('returns null rather than a negative or invented duration', () => {
        const t = '2026-10-12T13:15:00Z';
        // An inverted pair is a data problem, not something to render as "0s".
        expect(formatDuration('2026-10-12T13:16:00Z', t)).toBeNull();
        expect(formatDuration(null, t)).toBeNull();
        expect(formatDuration(t, null)).toBeNull();
        expect(formatDuration(undefined, undefined)).toBeNull();
        expect(formatDuration('not a date', t)).toBeNull();
    });
});

describe('fmtTokens', () => {
    it('marks an estimate with a tilde and passes a real count through', () => {
        expect(fmtTokens(3656)).toBe('3,656');
        expect(fmtTokens(3656, true)).toBe('~3,656');
        expect(fmtTokens(null)).toBe('—');
        expect(fmtTokens(undefined)).toBe('—');
    });
});

describe('formatRelativeWhen', () => {
    it('falls back to a dash rather than "Invalid Date"', () => {
        expect(formatRelativeWhen(null)).toBe('—');
        expect(formatRelativeWhen('')).toBe('—');
    });
});
