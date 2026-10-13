/**
 * Three-way merge for host hook entries.
 *
 * The host pack is the product's, but the file it writes into (`hooks.json`) is the consumer's:
 * the consumer keeps its own guards there — `guard-write.py`, `guard-shell.py`, its own matchers —
 * and may deliberately edit or wrap a line the product wrote. A plain two-way merge cannot tell
 * "the product changed its own line" from "the consumer changed the product's line", so it ends up
 * either clobbering the consumer or appending a duplicate that makes a hook fire twice.
 *
 * Identity is `--hook <name>` inside the command, and the previously written command is kept in
 * `.harness/host-install-state.json`. That gives the four outcomes that matter:
 *
 *   absent            → append
 *   present, untouched → update in place
 *   present, edited    → keep the consumer's version (and stop trying)
 *   product dropped it → prune, unless the consumer edited it first
 *
 * Identity deliberately does NOT live in `hooks.json` as an `id` field. That file is the host
 * application's config, not ours; adding an unrecognised key risks the host rejecting the entry,
 * and a rejected entry means a guard that silently stops running. Our bookkeeping stays in our
 * own file, which also means an already-installed consumer needs no migration.
 */

/** The marker that identifies a product hook inside a command. */
export function hookNameFromId(id) {
    const s = String(id || '');
    return s.startsWith('harness-eso-') ? s.slice('harness-eso-'.length) : s;
}

/**
 * The hook a command actually runs, read out of `--hook <name>`.
 *
 * Identity has to come from the command, not from the patch's `id`. The id names the *slot*
 * (`harness-eso-write-gate`) while the command names the *implementation* (`--hook guard-write`),
 * and the two legitimately differ. Matching on the id looked for `--hook write-gate`, never found
 * it, and appended a fresh copy on every run — the exact duplication this module exists to stop.
 */
export function hookNameFromCommand(command) {
    const m = /--hook[= ]([A-Za-z0-9_-]+)/.exec(String(command || ''));
    return m ? m[1] : '';
}

export function markerFor(hookName) {
    return `--hook ${hookName}`;
}

/**
 * The command inside an entry, whether the host nests it (`{hooks:[{command}]}` — Antigravity) or
 * keeps it flat (Cursor).
 */
export function entryCommand(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry.command === 'string' && entry.command) return entry.command;
    const nested = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const h of nested) {
        if (h && typeof h.command === 'string' && h.command) return h.command;
    }
    return '';
}



/**
 * Adopt the entry a profile declares, keeping any extra keys the consumer added.
 *
 * Updating only the command (all this merge used to do) meant a profile change to an entry's *shape* never
 * landed. That is not cosmetic: Antigravity takes a bare `{type, command}` for lifecycle events and a
 * `{matcher, hooks: [{type, command}]}` wrapper for tool events, so an entry stuck in the wrong shape
 * is a hook the host may not run. It is the same drift as the Cursor-vocabulary `hooks` block, one
 * level down.
 *
 * Unknown keys already on the entry are preserved (a consumer-added `timeout`, say); keys the profile
 * declares win. When the declared shape has no `hooks`, the wrapper from the old shape is dropped, so
 * the transition matcher-form → simple-form actually happens.
 *
 * @param {object} existing the entry currently in the host's config
 * @param {object} declared the entry from the profile (its `id` is not written out)
 */
export function withEntry(existing, declared) {
    const next = stripId(declared);
    if (!next || typeof next !== 'object') return existing;
    if (!existing || typeof existing !== 'object') return next;

    const out = { ...existing, ...next };

    if (Array.isArray(next.hooks)) {
        // Nested form: merge each declared hook over the one at the same index.
        const prior = Array.isArray(existing.hooks) ? existing.hooks : [];
        out.hooks = next.hooks.map((h, i) => ({ ...(prior[i] || {}), ...h }));
        // A bare `command` left over from the superseded shape is not consumer data.
        delete out.command;
        return out;
    }

    // Bare form: an old `hooks`/`matcher` wrapper is part of the superseded shape, not consumer data.
    delete out.hooks;
    delete out.matcher;
    return out;
}

/** Remove the product's `id` before writing — see the module docs for why. */
export function stripId(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const { id: _drop, ...rest } = entry;
    return rest;
}

/** True when two entries have the same wrapper shape (bare command vs nested `hooks`). */
function sameShape(a, b) {
    const nestedA = Array.isArray(a?.hooks);
    const nestedB = Array.isArray(b?.hooks);
    if (nestedA !== nestedB) return false;
    if (!nestedA) return (a?.matcher ?? null) === (b?.matcher ?? null);
    const innerA = a.hooks[0] || {};
    const innerB = b.hooks[0] || {};
    return (innerA.type ?? null) === (innerB.type ?? null) && (a.matcher ?? null) === (b.matcher ?? null);
}

function findOurIndex(list, hookName) {
    const marker = markerFor(hookName);
    return list.findIndex((e) => entryCommand(e).includes(marker));
}

/** `…/hooks/harness-eso/<file>.mjs` — the pre-pack layout this repo used to install. */
const LEGACY_HOOK_PATH_RE = /hooks\/harness-eso\/([A-Za-z0-9_.-]+)/;

/**
 * Is this entry a hook this repo installed before the host pack existed?
 *
 * Those commands were `node .cursor/hooks/harness-eso/guard-shell.mjs` — a shim that spawned the
 * implementation out of the product checkout, with no `--hook` marker to match on. Without this
 * check a re-provision would not recognise them, would append the new pack command beside them,
 * and the consumer would end up running both: the new guard and a shim that can no longer resolve
 * anything, which now exits non-zero. Detecting the directory we created is enough — it is ours,
 * and nothing the consumer wrote lives there.
 */
export function legacyHookName(entry) {
    const m = LEGACY_HOOK_PATH_RE.exec(entryCommand(entry));
    if (!m) return '';
    return m[1].replace(/\.mjs$/, '').replace(/-hook$/, '');
}

/** True when `legacyName` is the pre-pack file for `hookName` (`route` ↔ `route-hook`). */
function legacyMatches(legacyName, hookName) {
    if (!legacyName || !hookName) return false;
    return legacyName === hookName || legacyName.startsWith(hookName);
}

function findLegacyIndex(list, hookName) {
    return list.findIndex((e) => legacyMatches(legacyHookName(e), hookName));
}

/** Drop exact duplicate commands, preserving first-seen order. Legacy merges left these behind. */
export function compactEntries(list) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
        const key = entryCommand(entry) || JSON.stringify(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

/**
 * Merge one event's entries.
 *
 * @param {object[]} existing consumer entries for this event
 * @param {object[]} patch product entries for this event (`id` + command + host options)
 * @param {Record<string, {command: string, overridden?: boolean}>} [prev] our record for this event
 * @returns {{ list: object[], next: Record<string, {command: string, overridden?: boolean}>, report: object }}
 */
export function mergeEventEntries(existing, patch, prev = {}) {
    const list = compactEntries(existing);
    const next = {};
    const report = { added: [], updated: [], migrated: [], kept: [], overridden: [], pruned: [], missing: [] };

    for (const entry of Array.isArray(patch) ? patch : []) {
        const id = entry?.id || entryCommand(entry);
        const incoming = entryCommand(entry);
        const name = hookNameFromCommand(incoming) || hookNameFromId(id);
        if (!name) continue;
        const prevRec = prev[id];

        /*
         * Find our entry, in order of confidence: the `--hook` marker (normal case), the pre-pack
         * legacy path (migrating an install from before the host pack), then the exact command we
         * recorded last time. Skipping the legacy pass is what would leave a stale shim running
         * alongside its replacement.
         */
        let idx = findOurIndex(list, name);
        if (idx === -1) idx = findLegacyIndex(list, name);
        if (idx === -1 && prevRec?.command) {
            idx = list.findIndex((e) => entryCommand(e) === prevRec.command);
        }

        if (idx === -1) {
            list.push(stripId(entry));
            next[id] = { command: incoming, name };
            report.added.push(id);
            continue;
        }

        const wasLegacy = !entryCommand(list[idx]).includes(markerFor(name));
        const current = entryCommand(list[idx]);

        if (prevRec?.overridden && !wasLegacy) {
            // The consumer has taken this line over. Leave it alone and keep saying so.
            next[id] = { command: current, name, overridden: true };
            report.kept.push(id);
            continue;
        }

        if (prevRec && current !== prevRec.command && !wasLegacy) {
            // It changed since we wrote it and it was not us. Adopt their edit permanently.
            next[id] = { command: current, name, overridden: true };
            report.overridden.push(id);
            continue;
        }

        if (current !== incoming) {
            list[idx] = withEntry(list[idx], entry);
            if (wasLegacy) report.migrated.push(id);
            else report.updated.push(id);
        } else if (!sameShape(list[idx], entry)) {
            // Same command, different declared shape (e.g. matcher-form → bare form).
            list[idx] = withEntry(list[idx], entry);
            report.updated.push(id);
        } else {
            report.kept.push(id);
        }
        next[id] = { command: incoming, name };
    }

    /*
     * Any legacy entry we did not just migrate is a hook this repo no longer ships (`write-stamp`
     * is the real case). It cannot work any more — the shim it runs no longer resolves — so leaving
     * it wired would mean every tool call spawns a process that fails.
     */
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const legacyName = legacyHookName(list[i]);
        if (!legacyName) continue;
        if (Object.values(next).some((rec) => legacyMatches(legacyName, rec.name))) continue;
        list.splice(i, 1);
        report.pruned.push(`legacy:${legacyName}`);
    }

    // Prune entries the product no longer ships — but only the ones nobody has edited.
    const patchIds = new Set((Array.isArray(patch) ? patch : []).map((e) => e?.id || entryCommand(e)));
    for (const [id, rec] of Object.entries(prev || {})) {
        if (patchIds.has(id)) continue;
        const name = rec.name || hookNameFromId(id);
        const idx = findOurIndex(list, name);
        if (idx === -1) continue;
        if (rec.overridden || entryCommand(list[idx]) !== rec.command) continue;
        list.splice(idx, 1);
        report.pruned.push(id);
    }

    // A product hook we expect but could not place in the consumer's file is worth reporting:
    // a guard that never got wired looks exactly like a guard that passes.
    for (const [id, rec] of Object.entries(next)) {
        if (!findOurIndex(list, rec.name)) report.missing.push(id);
    }

    return { list, next, report };
}

/**
 * Merge a whole hooks document.
 *
 * Events are visited as the **union** of the patch and our previous record, not just the patch.
 * Iterating only the patch made pruning impossible: "remove every entry we own" is expressed as an
 * empty patch, and an empty patch visits no events at all, so the operation silently did nothing.
 * The same gap would leave an event wired forever once the product stopped declaring it.
 *
 * Events that end up with no entries are dropped rather than left as `[]`, so unwiring a tree
 * leaves the consumer's config the way it was before we touched it.
 *
 * @param {object} existing consumer document
 * @param {object} patch `{ hooks: { event: entries[] } }`
 * @param {Record<string, Record<string, {command: string}>>} [prevState] id → record, per event
 */
export function mergeHooksDocument(existing, patch, prevState = {}) {
    const hooksOut = {};
    for (const [event, list] of Object.entries(existing?.hooks || {})) {
        hooksOut[event] = compactEntries(list);
    }
    const nextState = {};
    const report = { added: [], updated: [], migrated: [], kept: [], overridden: [], pruned: [], missing: [] };

    const patchHooks = patch?.hooks || patch || {};
    /*
     * Visit the union of the patch, our previous record, **and every event already in the
     * document**.
     *
     * The third set is what makes cleanup complete. A fresh provision has no previous record, so
     * an event we no longer declare — say the pack stops shipping a `preCompact` hook — would never
     * be visited, and its old command would survive pointing at an implementation that no longer
     * exists. That is not hypothetical: it is exactly how a stale
     * `.agents/hooks/harness-eso/pre-compact.mjs` line outlived the shim it referenced.
     */
    const events = new Set([
        ...Object.keys(patchHooks),
        ...Object.keys(prevState),
        ...Object.keys(hooksOut),
    ]);
    for (const event of events) {
        if (event === 'version') continue;
        const entries = patchHooks[event];
        // A non-array patch value is not a hook list; leave that event untouched.
        if (entries !== undefined && !Array.isArray(entries)) continue;

        const { list, next, report: r } = mergeEventEntries(
            hooksOut[event] || [],
            Array.isArray(entries) ? entries : [],
            prevState[event] || {},
        );
        if (list.length) hooksOut[event] = list;
        else delete hooksOut[event];
        if (Object.keys(next).length) nextState[event] = next;
        for (const k of Object.keys(report)) report[k].push(...r[k]);
    }

    const out = { ...existing, hooks: hooksOut };
    return { document: out, state: nextState, report };
}
