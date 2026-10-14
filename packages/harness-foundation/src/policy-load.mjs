import fs from 'node:fs';
import path from 'node:path';
import { decisionPolicyFile } from './paths.mjs';
import { findRepoRoot } from './repo-root.mjs';

export const DEFAULT_POLICY = {
    version: 1,
    jev: { mode: 'off' },
    fallback: { l3_flash: false },
    on_ambiguous: 'hil_only',
    eso: {
        enabled: true,
        mode: 'observe',
        cognition: { insufficientPromptGate: 'consent' },
    },
    tokenDiet: {
        enabled: true,
        maxEagerRules: 6,
        maxEagerTokens: 5000,
    },
};

function deepMerge(base, over) {
    const out = { ...base };
    for (const key of Object.keys(over)) {
        const v = over[key];
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[key] === 'object') {
            out[key] = deepMerge(base[key], v);
        } else {
            out[key] = v;
        }
    }
    return out;
}

function applyEnvOverrides(policy) {
    const out = structuredClone(policy);
    const jevMode = process.env.JEV_MODE;
    if (jevMode && ['off', 'shadow', 'active'].includes(jevMode)) {
        out.jev = { ...out.jev, mode: jevMode };
    }
    const esoMode = process.env.ESO_MODE;
    if (esoMode && ['observe', 'hint', 'fail_closed'].includes(esoMode)) {
        out.eso = { ...out.eso, mode: esoMode };
    }
    return out;
}

/**
 * @param {{ root?: string, decisionPolicyPath?: string }} [cfg]
 */
export function loadDecisionPolicy(cfg = {}) {
    const filePath =
        cfg.decisionPolicyPath ||
        (cfg.root ? path.join(cfg.root, '.harness', 'decision-policy.json') : decisionPolicyFile());
    let policy = structuredClone(DEFAULT_POLICY);
    let fromFile = false;
    if (filePath && fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        policy = deepMerge(policy, raw);
        fromFile = true;
    }
    policy = applyEnvOverrides(policy);
    return { policy, path: filePath || '', fromFile };
}

export function loadDecisionPolicyForCwd() {
    return loadDecisionPolicy({ root: findRepoRoot() || undefined });
}
