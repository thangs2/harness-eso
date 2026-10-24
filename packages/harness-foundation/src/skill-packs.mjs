/**
 * Skill-pack shape and parsing — **the consumer declares, the product normalises**.
 *
 * Lives in foundation rather than eso-core because two readers need it and they sit on opposite sides
 * of the bundle boundary: eso-core resolves a pack per turn, and the host pack (which bundles only
 * `@mu/harness-foundation/pure`) must be able to load a consumer's manifest without reaching SQLite.
 * One normaliser, one shape — a second copy would be the drift this repo keeps paying for.
 */

/** The pack shape the rest of the engine reads. Kept in one place so the empty case cannot drift. */
export const EMPTY_PACK = { requiredDocTerms: [], minReadPaths: 0, lawQueries: [], codeQueries: [] };

/** The fields a pack can carry, in the order the projection lists them. */
export const PACK_FIELDS = ['requiredDocTerms', 'minReadPaths', 'lawQueries', 'codeQueries', 'description'];

/**
 * Normalise one declared pack. Every field is optional; anything absent is empty.
 * Unknown keys are dropped rather than passed through, so a typo cannot silently become live data.
 *
 * A field the source **does not mention** is left out of the result rather than defaulted here.
 * That distinction is load-bearing: `resolveSkillPack` merges a manifest over a legacy policy pack and
 * promises "the manifest wins for the fields it declares". If this normaliser emitted `lawQueries: []`
 * for an omitted field, that `[]` would overwrite a value the consumer had set elsewhere — a default
 * behaving like a declaration. Callers that need a complete pack apply {@link EMPTY_PACK}.
 */
export function normalisePack(pack) {
    const source = pack && typeof pack === 'object' ? pack : {};
    const strings = (value) =>
        Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : [];
    const out = {};
    if (source.requiredDocTerms !== undefined) out.requiredDocTerms = strings(source.requiredDocTerms);
    if (source.minReadPaths !== undefined) {
        out.minReadPaths = typeof source.minReadPaths === 'number' && source.minReadPaths >= 0 ? source.minReadPaths : 0;
    }
    if (source.lawQueries !== undefined) out.lawQueries = strings(source.lawQueries);
    if (source.codeQueries !== undefined) out.codeQueries = strings(source.codeQueries);
    // Carried for the operator surface; never used for a decision.
    if (source.description !== undefined) out.description = typeof source.description === 'string' ? source.description : '';
    return out;
}

/**
 * Read the packs a consumer declared in `.harness/skill-packs.json`.
 *
 * Shape — file version 1:
 *
 *     {
 *       "version": 1,
 *       "packs": {
 *         "backend": {
 *           "description": "NestJS + RabbitMQ service work",
 *           "requiredDocTerms": ["mu-bible"],
 *           "minReadPaths": 1,
 *           "lawQueries": ["mu-bible"],
 *           "codeQueries": ["backend/mu-"]
 *         }
 *       }
 *     }
 *
 * Deliberately tolerant of a bare `{ backend: {...} }` map (no `version`/`packs` wrapper): a manifest is
 * hand-written, and refusing the obvious shape with a schema error would make the first attempt fail
 * for no reason a reader could see. A manifest that is not an object at all yields `{}`.
 *
 * @param {unknown} manifest parsed JSON, or undefined when the consumer has no manifest
 * @returns {Record<string, object>} bucket → normalised pack
 */
export function parseSkillPacks(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {};
    const declared = manifest.packs && typeof manifest.packs === 'object' && !Array.isArray(manifest.packs)
        ? manifest.packs
        : Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'version' && key !== 'packs'));
    const out = {};
    for (const [bucket, pack] of Object.entries(declared)) {
        if (!bucket || typeof bucket !== 'string') continue;
        /*
         * Documentation keys are not buckets. Without this, `$comment` (the shipped template's prose)
         * would become a real, always-empty pack named `$comment` — harmless today, but it is a bucket
         * that nothing routes to and that would silently absorb a turn whose `packName` typo'd to it.
         * A leading `$` is the JSON-schema convention for "not data"; honour it.
         */
        if (bucket.startsWith('$')) continue;
        out[bucket] = normalisePack(pack);
    }
    return out;
}

