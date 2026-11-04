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

function createDispatcher(hostId, manifest) {
    const history = [];
    let seq = 0;

    return {
        getHistory() {
            return [...history];
        },
        dispatch(action) {
            if (!action || (typeof action !== 'object' && typeof action !== 'string')) {
                const err = new Error('INVALID_ACTION: Action must be an object or string');
                err.code = 'INVALID_ACTION';
                throw err;
            }

            const actionObj = typeof action === 'string' ? { type: action } : { ...action };
            const type = actionObj.type || actionObj.action || actionObj.name;
            if (!type) {
                const err = new Error('INVALID_ACTION: Action requires a type or action name');
                err.code = 'INVALID_ACTION';
                throw err;
            }

            const requiredCap = actionObj.capability || (
                type.startsWith('file_') ? 'file_tools' :
                type.startsWith('shell_') || type.startsWith('cmd_') ? 'shell_commands' :
                type.startsWith('subagent_') ? 'subagents' :
                type.includes('codegraph') ? 'codegraph_query' :
                type.includes('memory') ? 'agentmemory_query' :
                type.includes('deepseek') ? 'deepseek_direct' : null
            );

            if (requiredCap && manifest.capabilities[requiredCap] === 'UNAVAILABLE') {
                const err = new Error(
                    `CAPABILITY_UNAVAILABLE: Host '${hostId}' cannot dispatch action '${type}' requiring unavailable capability '${requiredCap}'`
                );
                err.code = 'CAPABILITY_UNAVAILABLE';
                err.host = hostId;
                err.capability = requiredCap;
                err.action = type;
                throw err;
            }

            seq++;
            const at = new Date().toISOString();
            const actionId = `act-${hostId}-${seq}-${Date.now()}`;

            const hasExecutor = typeof actionObj.execute === 'function' || typeof actionObj.handler === 'function';
            if (!hasExecutor) {
                const record = {
                    seq,
                    action_id: actionId,
                    host: hostId,
                    type,
                    payload: actionObj.payload || actionObj.data || null,
                    required_capability: requiredCap,
                    assurance: requiredCap ? manifest.capabilities[requiredCap] : 'NATIVE',
                    dispatched_at: at,
                    side_effect_applied: false,
                    result: null,
                    error: 'NO_EXECUTOR',
                };
                history.push(record);
                return {
                    action_id: actionId,
                    host: hostId,
                    type,
                    executed: false,
                    dispatched_at: at,
                    seq,
                    side_effect: null,
                    error: 'NO_EXECUTOR',
                };
            }

            let sideEffectResult = null;
            if (typeof actionObj.execute === 'function') {
                sideEffectResult = actionObj.execute();
            } else if (typeof actionObj.handler === 'function') {
                sideEffectResult = actionObj.handler();
            }

            const record = {
                seq,
                action_id: actionId,
                host: hostId,
                type,
                payload: actionObj.payload || actionObj.data || null,
                required_capability: requiredCap,
                assurance: requiredCap ? manifest.capabilities[requiredCap] : 'NATIVE',
                dispatched_at: at,
                side_effect_applied: true,
                result: sideEffectResult,
            };

            history.push(record);

            return {
                action_id: actionId,
                host: hostId,
                type,
                executed: true,
                dispatched_at: at,
                seq,
                side_effect: record,
            };
        },
    };
}

export function createHostAdapter(hostId) {
    let manifestData;
    switch (hostId) {
        case 'cursor':
            manifestData = {
                host_id: 'cursor',
                capabilities: {
                    file_tools: 'NATIVE',
                    shell_commands: 'NATIVE',
                    subagents: 'NATIVE',
                    codegraph_query: 'NATIVE',
                    agentmemory_query: 'NATIVE',
                    deepseek_direct: 'NATIVE',
                },
            };
            break;
        case 'antigravity':
            manifestData = {
                host_id: 'antigravity',
                capabilities: {
                    file_tools: 'NATIVE',
                    shell_commands: 'NATIVE',
                    subagents: 'NATIVE',
                    codegraph_query: 'EMULATED',
                    agentmemory_query: 'EMULATED',
                    deepseek_direct: 'EMULATED',
                },
            };
            break;
        case 'deepseek-harness':
            manifestData = {
                host_id: 'deepseek-harness',
                capabilities: {
                    file_tools: 'NATIVE',
                    shell_commands: 'NATIVE',
                    subagents: 'EMULATED',
                    codegraph_query: 'UNAVAILABLE',
                    agentmemory_query: 'UNAVAILABLE',
                    deepseek_direct: 'UNAVAILABLE',
                },
            };
            break;
        default: {
            const err = new Error(`UNKNOWN_HOST_ADAPTER: No adapter found for host '${hostId}'`);
            err.code = 'UNKNOWN_HOST_ADAPTER';
            throw err;
        }
    }

    const manifest = validateHostManifest(manifestData);
    const dispatcher = createDispatcher(hostId, manifest);

    return {
        host_id: hostId,
        manifest,
        dispatch: (action) => dispatcher.dispatch(action),
        getDispatchHistory: () => dispatcher.getHistory(),
    };
}
