/**
 * @mu/eso-core — Host Contract & Adapters (WP 8.1 / ESO-227)
 *
 * Implements:
 * - Exactly 3 assurance levels: NATIVE, EMULATED, UNAVAILABLE (no 4th level)
 * - Required capability schema: hosts declaring missing capability or invalid level are rejected
 * - Three concrete host adapters: cursor, antigravity, deepseek-harness
 */

export const ASSURANCE_LEVELS = Object.freeze(['NATIVE', 'EMULATED', 'UNAVAILABLE']);

export const REQUIRED_CAPABILITIES = Object.freeze([
    'file_tools',
    'shell_commands',
    'subagents',
    'codegraph_query',
    'agentmemory_query',
    'deepseek_direct',
]);

export function validateHostManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        const err = new Error('Host manifest is required');
        err.code = 'INVALID_HOST_MANIFEST';
        throw err;
    }
    if (!manifest.host_id || typeof manifest.host_id !== 'string') {
        const err = new Error('host_id is required');
        err.code = 'INVALID_HOST_MANIFEST';
        throw err;
    }

    const capabilities = manifest.capabilities || {};
    for (const cap of REQUIRED_CAPABILITIES) {
        if (!(cap in capabilities)) {
            const err = new Error(`INVALID_HOST_MANIFEST: Host '${manifest.host_id}' lacks required capability declaration '${cap}'`);
            err.code = 'INVALID_HOST_MANIFEST';
            err.missing_capability = cap;
            throw err;
        }

        const level = capabilities[cap];
        if (!ASSURANCE_LEVELS.includes(level)) {
            const err = new Error(
                `INVALID_ASSURANCE_LEVEL: Capability '${cap}' has invalid assurance level '${level}'. Must be exactly one of: ${ASSURANCE_LEVELS.join(', ')}`
            );
            err.code = 'INVALID_ASSURANCE_LEVEL';
            err.capability = cap;
            err.level = level;
            throw err;
        }
    }

    return {
        valid: true,
        host_id: manifest.host_id,
        capabilities: { ...capabilities },
    };
}

export function createHostAdapter(hostId) {
    switch (hostId) {
        case 'cursor':
            return {
                host_id: 'cursor',
                manifest: validateHostManifest({
                    host_id: 'cursor',
                    capabilities: {
                        file_tools: 'NATIVE',
                        shell_commands: 'NATIVE',
                        subagents: 'NATIVE',
                        codegraph_query: 'NATIVE',
                        agentmemory_query: 'NATIVE',
                        deepseek_direct: 'NATIVE',
                    },
                }),
                dispatch(action) { return { host: 'cursor', executed: action, status: 'ok' }; },
            };
        case 'antigravity':
            return {
                host_id: 'antigravity',
                manifest: validateHostManifest({
                    host_id: 'antigravity',
                    capabilities: {
                        file_tools: 'NATIVE',
                        shell_commands: 'NATIVE',
                        subagents: 'NATIVE',
                        codegraph_query: 'EMULATED',
                        agentmemory_query: 'EMULATED',
                        deepseek_direct: 'EMULATED',
                    },
                }),
                dispatch(action) { return { host: 'antigravity', executed: action, status: 'ok' }; },
            };
        case 'deepseek-harness':
            return {
                host_id: 'deepseek-harness',
                manifest: validateHostManifest({
                    host_id: 'deepseek-harness',
                    capabilities: {
                        file_tools: 'NATIVE',
                        shell_commands: 'NATIVE',
                        subagents: 'EMULATED',
                        codegraph_query: 'UNAVAILABLE',
                        agentmemory_query: 'UNAVAILABLE',
                        deepseek_direct: 'UNAVAILABLE',
                    },
                }),
                dispatch(action) { return { host: 'deepseek-harness', executed: action, status: 'ok' }; },
            };
        default: {
            const err = new Error(`UNKNOWN_HOST_ADAPTER: No adapter found for host '${hostId}'`);
            err.code = 'UNKNOWN_HOST_ADAPTER';
            throw err;
        }
    }
}
