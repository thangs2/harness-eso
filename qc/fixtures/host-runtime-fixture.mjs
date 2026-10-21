/** Shared fixtures for host-runtime / DSH plugin tests. Not a test file: importing it runs nothing. */
export function policyWithNativeMemory() {
    return {
        version: 1,
        jev: { mode: 'off' },
        fallback: { l3_flash: false },
        on_ambiguous: 'hil_only',
        eso: {
            enabled: true,
            mode: 'hint',
            enforceWrites: 'off',
            thresholds: { T_low: 0.45, T_high: 0.72 },
            preflight: { enabled: true },
            cognition: { insufficientPromptGate: 'consent' },
            sources: {
                law: { enabled: false },
                code: { enabled: false },
                memory: { enabled: true, prefer: ['native'], fallback: ['none'] },
            },
        },
    };
}

export function nativeMemoryProvider() {
    return {
        id: 'native:test-memory',
        kinds: ['memory'],
        capability: 'native',
        ceiling: 0.6,
        async fetch() {
            return {
                snippets: [{ kind: 'memory', text: 'tenant id comes from the request context', provenance: { kind: 'session', sessionSeq: 7 } }],
                trace: 'native:test-memory:1',
            };
        },
    };
}
