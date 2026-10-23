/**
 * Path policy — which paths a write gate protects, and why.
 *
 * This exists because **protect** and **source of truth** are different questions, and conflating them
 * produced several concrete bugs:
 *
 *   - `sdlc/` sat in the protected list even though `locked-paths.txt` said "sdlc/ is the writable
 *     working tree. Do not lock it." The agent could not write a QC artefact there without first
 *     satisfying the ESO gate, while the repo's own comment said it should be free.
 *   - The observer carried a *second* protected list (a regex in `checks.mjs`), drift already visible:
 *     it was blind to 9 of the 19 paths the guard protects, including `scripts/ci/` — the scripts that
 *     decide whether a slice passes.
 *   - `document/` was protected only where someone had typed `document/mu/`, so `document/harness/`
 *     was ungated by accident rather than by decision.
 *
 * Orthogonality is the point:
 *
 * |            | source of truth | not source of truth |
 * |------------|-----------------|---------------------|
 * | gated      | `document/mu/`  | `scripts/ci/`       |
 * | writable   | `sdlc/08.wbs/`  | `tmp/`              |
 *
 * `sdlc/08.wbs/` **is** the WBS source of truth and agents must maintain it. `scripts/ci/` is not a
 * source of truth and is protected anyway, because editing the yardstick is how you make it read PASS.
 * One axis cannot express both, so `sot` is a label and the enforce modes are a separate question.
 *
 * The lists are **consumer policy**, not product constants: `sdlc/` and `document/mu/` mean nothing in
 * a repo that has neither. They live in `.harness/decision-policy.json` (already read by both the JS
 * hooks and the Python guards) under `paths`, and this module only resolves them.
 *
 * @typedef {'locked' | 'gated' | 'ask'} PathMode
 */

/**
 * Product defaults, used when a consumer has not declared `paths`.
 *
 * Deliberately not empty. A consumer that has not migrated must not silently lose its gate — absent
 * configuration means "use the historical protection", and only an **explicit empty list** means
 * "protect nothing here". That distinction is load-bearing: without it, shipping this feature would
 * have been an unannounced removal of every protection.
 *
 * Mechanism-generic since P-27: this list ships **inside the host pack**, so it must protect things
 * every consumer has (playbooks, both IDE trees, the guards, the evidence tree) and must not name one
 * consumer's architecture. It used to carry `frontend/`, `backend/mu-*`, `document/mu/` — another
 * product's directories — and `guard-write.py` falls back to this file only for a consumer that
 * declares no `paths` at all, so `fineso` observed it as "inert today, another product's list the
 * moment `paths` is dropped".
 */
export const DEFAULT_PATH_POLICY = {
    /*
     * `mcp.json` files hold the credentials the MCP servers run with, and the root `.mcp.json` is a
     * copy of one of them. They are `locked` rather than `gated`: a stamp is evidence that an agent
     * read enough context, not that a human agreed to edit a secret, and a gated entry could be
     * opened by a turn that happened to collect enough evidence (H7).
     */
    locked: [
        '.cursor/mcp.json',
        '.vscode/mcp.json',
        '.agents/mcp_config.json',
        '.mcp.json',
    ],
    gated: [
        'AGENTS.md',
        '.cursorrules',
        '.cursor/instructions.md',
        '.agents/instructions.md',
        '.cursor/rules/',
        '.agents/rules/',
        '.cursor/skills/',
        '.agents/skills/',
        '.cursor/agents/',
        '.agents/agents/',
        'scripts/ci/',
        'installation/docgraph/',
        'docgraph.scope',
        '.cursor/hooks/guard-write.py',
        '.cursor/hooks/guard-shell.py',
        '.agents/hooks/guard-write.py',
        '.agents/hooks/guard-shell.py',
        /*
         * Governance prose and harness state, gated for every consumer (P-27).
         *
         * `SDLC/` and `sdlc/` are where a consumer keeps its law, context contract and agent manifests;
         * `.harness/` holds the decision policy and host pack. Both are what the gate is *about*, so a
         * consumer that lists `paths` without them left its own law writable by an ungated turn
         * (`atrievefin`: `SDLC/00.governance/03.decision-register.md` → `allow`; `fineso`: same).
         */
        'SDLC/',
        'sdlc/',
        '.harness/',
    ],
    /*
     * Paths that require a **human** signal, not evidence. `ask` exists because some writes should not
     * be auto-openable by an agent that has read enough files — the operating model and the WBS are
     * that kind of artefact.
     *
     * HONEST LIMITATION: Cursor's hook contract accepts only `allow` and `deny` — measured from the
     * shipped bundle, which warns `'ask' permission … is not yet implemented. Use 'allow' or 'deny'`.
     * So a hook cannot prompt. `ask` is therefore enforced as a deny that names what the human must do,
     * and it needs a **human-only** consent channel to become a real gate. Until that exists it behaves
     * like `locked` with a clearer message — and it must NOT be satisfiable by a file the agent can
     * write, or it degrades to `allow` (the same hole as a self-issued `hilWaiver`).
     */
    ask: [],
    /** Read-authority registry. **No enforcement** — see the module note. */
    sot: [],
};

/**
 * Does one policy entry cover a path?
 *
 * Three shapes, distinguished by the entry itself, because they need different matching and the old code
 * kept them in **two** lists (`PROTECTED_PREFIXES` matched with `startswith`, `PROTECTED_EXACT` with
 * equality) — a distinction that was lost when they were collapsed into one policy list, and losing it
 * silently un-gated `backend/mu-`.
 *
 * | entry | means | matches |
 * |---|---|---|
 * | `frontend/` | a directory | the directory itself, and everything below it |
 * | `backend/mu-*` | a name prefix | `backend/mu-fusion`, `backend/mu-infra-lib`, … |
 * | `AGENTS.md` | one file | exactly that path, never a sibling like `AGENTS.md.bak` |
 *
 * The third row is why equality is not simply relaxed to `startsWith`: the root playbook files are exact
 * on purpose, so that drafts and `.bak` copies stay writable and a cleanup script can remove them.
 */
export function pathMatches(rel, entry) {
    if (!rel || !entry) return false;
    if (entry.endsWith('/')) return rel === entry.slice(0, -1) || rel.startsWith(entry);
    if (entry.endsWith('*')) return rel.startsWith(entry.slice(0, -1));
    return rel === entry;
}

/** A path is protected if some entry covers it. @deprecated name kept for callers; use `pathMatches`. */
function matches(rel, entry) {
    return pathMatches(rel, entry);
}

/** Normalise a path or target to a repo-relative form, so policy entries can stay short. */
export function toRepoRelative(target, root) {
    let rel = String(target || '').trim();
    if (!rel) return '';
    const base = String(root || '').replace(/\/+$/, '');
    if (base && rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1);
    if (rel.startsWith('./')) rel = rel.slice(2);
    return rel;
}

/**
 * Resolve the effective policy: product defaults, with every key the consumer declared replacing it.
 *
 * Arrays replace rather than merge. A consumer that declares `gated` is stating its list, and merging
 * would resurrect defaults it deliberately removed — the `sdlc/` case exactly.
 *
 * @param {{ paths?: object } | null | undefined} policy  the loaded decision policy
 * @returns {{ locked: string[], gated: string[], ask: string[], sot: string[], declared: boolean, replaced: string[] }}
 */
export function resolvePathPolicy(policy) {
    const declared = policy?.paths && typeof policy.paths === 'object';
    const out = {};
    /* Which tiers the consumer's own file overrode — reported, so a replaced default is never silent. */
    const replaced = [];
    for (const key of ['locked', 'gated', 'ask', 'sot']) {
        const fromPolicy = declared ? policy.paths[key] : undefined;
        if (Array.isArray(fromPolicy)) {
            out[key] = fromPolicy.map(String).filter(Boolean);
            replaced.push(key);
        } else {
            out[key] = [...DEFAULT_PATH_POLICY[key]];
        }
    }
    out.declared = Boolean(declared);
    out.replaced = replaced;
    return out;
}

/**
 * The enforce mode for one path, or `null` when it is freely writable.
 *
 * Precedence is `locked` → `ask` → `gated`, most restrictive first, so a path accidentally listed in
 * two tiers cannot be loosened by the second entry.
 *
 * @param {string} target  path, absolute or repo-relative
 * @param {ReturnType<typeof resolvePathPolicy>} resolved
 * @param {string} [root]
 * @returns {PathMode | null}
 */
export function pathMode(target, resolved, root) {
    const rel = toRepoRelative(target, root);
    if (!rel) return null;
    for (const mode of ['locked', 'ask', 'gated']) {
        if ((resolved[mode] || []).some((e) => matches(rel, e))) return mode;
    }
    return null;
}

/**
 * Is this path a registered source of truth? Labelling only — nothing is denied on this answer.
 *
 * @param {string} target
 * @param {ReturnType<typeof resolvePathPolicy>} resolved
 * @param {string} [root]
 */
export function isSotPath(target, resolved, root) {
    const rel = toRepoRelative(target, root);
    if (!rel) return false;
    return (resolved.sot || []).some((e) => matches(rel, e));
}
