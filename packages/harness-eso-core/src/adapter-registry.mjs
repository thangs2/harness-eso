import { adapter as docgraphLaw } from '../adapters/docgraph-law.mjs';
import { adapter as codegraphCode } from '../adapters/codegraph-code.mjs';
import { adapter as noopMemory } from '../adapters/noop-memory.mjs';
import { adapter as agentmemoryMemory } from '../adapters/agentmemory-memory.mjs';

const BUILTINS = [docgraphLaw, codegraphCode, noopMemory, agentmemoryMemory];

/**
 * @param {object} policy
 * @param {import('../adapters/docgraph-law.mjs').adapter[]} [extra]
 */
export function createSourceRegistry(policy, extra = []) {
    const all = [...BUILTINS, ...extra];
    const byId = new Map(all.map((a) => [a.id, a]));
    return {
        resolve(kind) {
            const src = policy?.eso?.sources?.[kind];
            if (src?.enabled === false) return null;
            const id = src?.adapter;
            if (id && byId.has(id)) {
                const ad = byId.get(id);
                if (ad.kinds.includes(kind) && ad.enabled(policy)) return ad;
            }
            return all.find((a) => a.kinds.includes(kind) && a.enabled(policy)) || null;
        },
        list() {
            return all.filter((a) => a.enabled(policy));
        },
    };
}
