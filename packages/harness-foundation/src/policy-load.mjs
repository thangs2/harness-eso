import fs from 'node:fs';
import path from 'node:path';
import { decisionPolicyFile } from './paths.mjs';
import { findRepoRoot } from './repo-root.mjs';
import { parseSkillPacks } from './skill-packs.mjs';

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
        maxEagerRules: 7,
        maxEagerTokens: 10000,
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

/** The consumer's skill-pack manifest, beside its decision policy. */
export const SKILL_PACKS_NAME = 'skill-packs.json';

/**
 * Read `.harness/skill-packs.json` — what kinds of work need which evidence, **declared per repo**.
 *
 * Kept separate from `decision-policy.json` on purpose. The policy is *how a decision is made*; the
 * packs are *what this repo's work needs*, and they are the file an operator is expected to edit by
 * hand — the analogue of a `CLAUDE.md` / `AGENTS.md` map. Mixing them would put a hand-maintained,
 * project-shaped table inside the file the product's defaults are merged into.
 *
 * Never throws: a manifest is operator-authored, and a malformed one must not take down a preflight.
 * A parse error is reported through `error` so the projection can show it instead of silently behaving
 * as if the consumer had declared nothing.
 *
 * @param {{ root?: string, skillPacksPath?: string }} [cfg]
 * @returns {{ manifest: object, packs: Record<string, object>, path: string, fromFile: boolean, error: string|null }}
 */
export function loadSkillPacks(cfg = {}) {
    const filePath =
        cfg.skillPacksPath ||
        (cfg.root ? path.join(cfg.root, '.harness', SKILL_PACKS_NAME) : '');
    const empty = { manifest: {}, packs: {}, path: filePath || '', fromFile: false, error: null };
    if (!filePath || !fs.existsSync(filePath)) return empty;
    try {
        const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { manifest, packs: parseSkillPacks(manifest), path: filePath, fromFile: true, error: null };
    } catch (err) {
        return { ...empty, fromFile: true, error: `skill-packs.json: ${err.message}` };
    }
}
