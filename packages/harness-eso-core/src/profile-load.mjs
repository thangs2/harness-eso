import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDecisionPolicy } from '@mu/harness-foundation/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where bundled profiles live.
 *
 * Resolving this from `__dirname` alone was a silent-failure trap: bundle this module into the
 * host pack and `../../../profiles` points at the pack, which has no `profiles/` — `existsSync`
 * returns false, the profile becomes `{}`, and the caller loses every `eso.thresholds`,
 * `eso.mode` and `preflight.enabled` value without a single warning. The env override is what
 * the observe server and containers already set, so honour it first.
 */
function profilesDir() {
    return process.env.HARNESS_PROFILES_DIR || path.resolve(__dirname, '../../../profiles');
}

/**
 * Load a bundled profile and merge it into the decision policy defaults.
 *
 * @param {string} [profileId]
 * @param {{ root?: string, profilesDir?: string }} [cfg]
 */
export function loadHarnessProfile(profileId = 'generic-eso', cfg = {}) {
    const dir = cfg.profilesDir || profilesDir();
    const file = path.join(dir, `${profileId}.json`);
    if (!fs.existsSync(file)) {
        // Fail loudly. A missing profile means the caller is about to run with defaults instead of
        // the configured thresholds, which changes what the GATE decides.
        throw new Error(
            `harness profile "${profileId}" not found at ${file} — set HARNESS_PROFILES_DIR to the profiles/ directory`,
        );
    }
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { policy: base } = loadDecisionPolicy(cfg);
    const merged = structuredClone(base);
    if (profile.jev) merged.jev = { ...merged.jev, ...profile.jev };
    if (profile.eso) merged.eso = deepMerge(merged.eso || {}, profile.eso);
    if (profile.fallback) merged.fallback = { ...merged.fallback, ...profile.fallback };
    if (profile.on_ambiguous) merged.on_ambiguous = profile.on_ambiguous;
    return { profileId, profile, policy: merged };
}

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
