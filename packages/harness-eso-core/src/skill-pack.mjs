/**
 * Skill packs — **declared by the consumer, never by the product**.
 *
 * A *pack* answers one question for one kind of work: to be competent at a `backend` change in *this*
 * repo, which law must the agent have read and which code must it have looked at? The answer is a
 * property of the repository, so it belongs in the repository.
 *
 *     surface bucket (`tools` | `backend` | `frontend` | `docs` | `root` | a custom name)
 *         └─▶ pack: requiredDocTerms · minReadPaths · lawQueries · codeQueries
 *
 * ## Why this file has no built-in table (it used to)
 *
 * Through 2026-10 the buckets were a `PACKS` literal in this module, carrying terms from the first
 * consumer: `harness-tooling`, `mu-bible`, `stack.fe.angular`. Two defects came from that and G-01
 * records them:
 *
 *   1. `root` resolved into the `tools` pack, so *any* consumer's root turn inherited three law terms
 *      that exist in exactly one repository. The evidence score could not reach `T_high` in any turn,
 *      and no amount of reading could close the gap — a gate that cannot open.
 *   2. The fix at the time was to add a `root` pack with zero terms, which treated the symptom. The
 *      disease is that the product shipped **domain values**, against its own rule (`01.overview/
 *      06.concept-mission-vision.md` §3: "the product will not ship domain values").
 *
 * Deleting the table removes the class. A bucket with no declared pack is **empty, not guessed** — the
 * honest reading of "this consumer has not said what this kind of work needs". An empty pack demands no
 * evidence, so it can never make a gate unclosable; it only stops the product from claiming to know.
 *
 * A legacy `policy.skillPacks` map still merges under the manifest, so an existing consumer that wrote
 * it into `decision-policy.json` keeps working without a migration step.
 */

import { EMPTY_PACK, normalisePack } from '@mu/harness-foundation/pure';

/**
 * Resolve the pack for a surface.
 *
 * Precedence, highest first:
 *   1. the consumer's manifest (`.harness/skill-packs.json`)
 *   2. a legacy `skillPacks` map inside the policy (per key, so a manifest entry that omits a field
 *      inherits the policy's value for that field — not the whole pack)
 *   3. empty
 *
 * `surface.packName` (optional) redirects to a named pack — this is how one bucket serves two very
 * different kinds of work, e.g. a `backend` turn that is really RabbitMQ topology work selecting a
 * `messaging` pack. Without it, packs could only be as fine-grained as the classifier.
 *
 * @param {{ bucket?: string, packName?: string }} surface
 * @param {object} [policy]
 * @param {Record<string, object>} [manifestPacks] from {@link parseSkillPacks}
 */
export function resolveSkillPack(surface, policy = {}, manifestPacks = {}) {
    const bucket = surface?.packName || surface?.bucket || 'general';

    const fromManifest = manifestPacks?.[bucket];
    const legacyPacks = policy?.skillPacks || policy?.eso?.skillPacks;
    const legacy = legacyPacks?.[bucket];

    if (!fromManifest && !(legacy && typeof legacy === 'object')) {
        // Nothing declared: empty, and `bucket` still reports what was asked for, so the projection can
        // say "no pack declared for `backend`" instead of silently demanding nothing.
        return { ...EMPTY_PACK, bucket, declared: false };
    }

    /*
     * Per-field precedence, and it has to be computed on the **raw** entries.
     *
     * `manifestPacks` came through `parseSkillPacks`, which fills every absent field (`lawQueries: []`,
     * `minReadPaths: 0`). Spreading that over the legacy pack therefore *overwrote* a policy value with
     * the normaliser's default — a manifest that declared only `requiredDocTerms` silently deleted the
     * consumer's `lawQueries`. Merging the source objects first, then normalising, keeps "manifest wins
     * for the field it declares" literal: a field the manifest omits is genuinely absent, not empty.
     */
    const merged = normalisePack({
        ...(legacy && typeof legacy === 'object' ? legacy : {}),
        ...(fromManifest && typeof fromManifest === 'object' ? fromManifest : {}),
    });
    // Total always: a caller must never have to check whether a field exists.
    return { ...EMPTY_PACK, description: '', ...merged, bucket, declared: true };
}
