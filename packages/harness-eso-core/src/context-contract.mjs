import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONTRACT_REL_PATHS = [
    'sdlc/00.governance/00.context-contract.json',
    '.harness/context-contract.json',
    'context-contract.json',
];

/**
 * Loads a Context Contract from consumer repository root.
 *
 * @param {string} [root]
 * @param {string|null} [explicitPath]
 * @returns {{ version?: number, domains: Record<string, object>, globalInvariants: string[], contractMissing: boolean, contractPath?: string }}
 */
export function loadContextContract(root = process.cwd(), explicitPath = null) {
    const candidates = explicitPath
        ? [path.isAbsolute(explicitPath) ? explicitPath : path.join(root, explicitPath)]
        : DEFAULT_CONTRACT_REL_PATHS.map((rel) => path.join(root, rel));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf8');
                const doc = JSON.parse(raw);
                if (doc && typeof doc === 'object') {
                    return {
                        version: doc.version ?? 1,
                        domains: doc.domains && typeof doc.domains === 'object' ? doc.domains : {},
                        globalInvariants: Array.isArray(doc.globalInvariants) ? doc.globalInvariants : [],
                        contractMissing: false,
                        contractPath: p,
                    };
                }
            }
        } catch {
            /* continue searching */
        }
    }

    // Fail-visible fallback: missing contract does NOT crash or block writes (Decision D-03)
    return {
        contractMissing: true,
        domains: {},
        globalInvariants: [],
    };
}

/**
 * Resolves which domain applies to the current turn based on query stem, file paths, or hint.
 *
 * @param {object} contract
 * @param {{ stem?: string, paths?: string[], domainHint?: string }} context
 * @returns {{ domain: string, requiredInvariants: string[], paths?: string[], matchedBy?: string }}
 */
export function resolveDomainContract(contract, context = {}) {
    const { stem = '', paths = [], domainHint = '' } = context;
    const domains = contract?.domains || {};

    // 1. Exact match via explicit domainHint
    if (domainHint && domains[domainHint]) {
        return {
            domain: domainHint,
            requiredInvariants: Array.isArray(domains[domainHint].requiredInvariants)
                ? domains[domainHint].requiredInvariants
                : [],
            paths: domains[domainHint].paths || [],
            matchedBy: 'hint',
        };
    }

    // 2. Keyword match in user query stem
    const normalizedStem = String(stem || '').toLowerCase();
    for (const [domainName, domainCfg] of Object.entries(domains)) {
        const keywords = Array.isArray(domainCfg.keywords) ? domainCfg.keywords : [domainName];
        for (const kw of keywords) {
            const pattern = new RegExp(`\\b${escapeRegExp(kw.toLowerCase())}\\b`, 'i');
            if (pattern.test(normalizedStem)) {
                return {
                    domain: domainName,
                    requiredInvariants: Array.isArray(domainCfg.requiredInvariants)
                        ? domainCfg.requiredInvariants
                        : [],
                    paths: domainCfg.paths || [],
                    matchedBy: 'keyword',
                };
            }
        }
    }

    // 3. Path matching
    if (Array.isArray(paths) && paths.length > 0) {
        for (const [domainName, domainCfg] of Object.entries(domains)) {
            const domainPaths = Array.isArray(domainCfg.paths) ? domainCfg.paths : [];
            for (const dp of domainPaths) {
                const cleanDp = dp.replace(/\*\*.*$/, '').replace(/\/$/, '').toLowerCase();
                for (const p of paths) {
                    if (String(p || '').toLowerCase().includes(cleanDp)) {
                        return {
                            domain: domainName,
                            requiredInvariants: Array.isArray(domainCfg.requiredInvariants)
                                ? domainCfg.requiredInvariants
                                : [],
                            paths: domainCfg.paths || [],
                            matchedBy: 'path',
                        };
                    }
                }
            }
        }
    }

    return {
        domain: 'default',
        requiredInvariants: [],
        paths: [],
        matchedBy: 'none',
    };
}

/**
 * Compiles pinned invariants for a turn:
 * Required = GlobalInvariants U Domain.requiredInvariants
 * Pinned = Required INTERSECT Attested (or Required if no attested provided)
 *
 * @param {object} contract
 * @param {{ stem?: string, paths?: string[], domainHint?: string, attestedInvariants?: string[] }} context
 * @returns {{ pinnedInvariants: string[], domain: string, contractMissing: boolean, requiredInvariants: string[] }}
 */
export function compilePinnedInvariants(contract, context = {}) {
    if (!contract || contract.contractMissing) {
        return {
            pinnedInvariants: [],
            domain: 'default',
            contractMissing: true,
            requiredInvariants: [],
        };
    }

    const domainInfo = resolveDomainContract(contract, context);
    const globalInvs = Array.isArray(contract.globalInvariants) ? contract.globalInvariants : [];
    const domainInvs = domainInfo.requiredInvariants || [];

    const requiredSet = new Set([...globalInvs, ...domainInvs]);
    const requiredInvariants = Array.from(requiredSet);

    const attested = Array.isArray(context.attestedInvariants) ? context.attestedInvariants : [];
    let pinnedInvariants;

    if (attested.length > 0) {
        // Intersection: Required INTERSECT Attested
        const attestedSet = new Set(attested.map((id) => String(id).toUpperCase()));
        pinnedInvariants = requiredInvariants.filter((id) => attestedSet.has(id.toUpperCase()));
        // If intersection is empty, fallback to required domain invariants
        if (pinnedInvariants.length === 0) {
            pinnedInvariants = requiredInvariants;
        }
    } else {
        pinnedInvariants = requiredInvariants;
    }

    return {
        pinnedInvariants,
        domain: domainInfo.domain,
        contractMissing: false,
        requiredInvariants,
    };
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
