/**
 * Are the consumer's Python guards the ones this product ships?
 *
 * ## Why a separate module
 *
 * `guard-write.py` and `guard-shell.py` are **copied once** into `.cursor/hooks/` and `.claude/hooks/`
 * at provision time, and `installHostPack` deliberately never rewrites them (`create-if-missing`,
 * "preserving existing operator customizations"). Atrievefin, 2026-10-23: `./provision.sh
 * atrievefin --force` reported `13 created, 2 updated`, `verify host` reported **PASS H1**, and both
 * guard files were still byte-identical to a build from before the fix — so the operator was told the
 * consumer had the new guard, and it did not. That is the H1 defect this module exists to close: H1
 * asked "is a guard wired", never "is it this product's guard".
 *
 * ## What it does and does not claim
 *
 * It compares **hashes of shipped templates**, nothing else. It cannot know whether a consumer
 * changed its guard on purpose — the answer to that is in the consumer's git history, not in a hook.
 * So it reports one of:
 *
 *   `current`      all guard files match the shipped template
 *   `stale`        some differ; `behind` names them, with a one-sentence consequence
 *   `customised`   the file carries the marker it would have if a human edited it — reported, not
 *                  treated as an error, because a consumer's own guard is legitimate (F26/§18)
 *   `not-applied`  no tree has the guard; H1 already fails on wiring, this is the same fact named
 *
 * "Stale" is the state that must be **visible**, because it is the only one where the product's own
 * behaviour (a deny message, a verdict source, a gap exemption) silently differs between two
 * consumers running the same `harness-eso` build.
 *
 * ## Where the template is
 *
 * `profiles/templates/hooks/` — resolved exactly the way `host-install.mjs` resolves it, including
 * `HARNESS_PROFILES_DIR`. A second resolution rule would let this check disagree with the installer
 * about which template is "the template", which is the class of defect it is meant to catch.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR_DEFAULT = path.resolve(HERE, '../../../profiles');

/** Trees a guard is copied into, and the manifest file that says the tree is wired. */
const TREES = [
    { id: 'cursor', hooks: '.cursor/hooks', wiring: '.cursor/hooks.json' },
    { id: 'claude', hooks: '.claude/hooks', wiring: '.claude/settings.json' },
    { id: 'agents', hooks: '.agents/hooks', wiring: '.agents/hooks.json' },
];

/** Guard files the pack copies. `pre-tool-use.py` is agents-only and is included because it decides. */
const GUARDS = ['guard-write.py', 'guard-shell.py', 'pre-tool-use.py'];

/**
 * Which shipped behaviour a stale file would be missing, in the words of the register.
 *
 * Kept here rather than in a doc because the *check* is the thing that reads it: a stale report that
 * says only "differs" makes the operator spend a session on `diff`, while "your deny message still
 * offers `eso.mode`" tells them what they are seeing.
 */
const SINCE = {
    'guard-write.py': 'G-08/G-12: the deny message is composed from the verdict (unanswerable gaps, defaulted enforceWrites, receipt source) and says "every closable gap" — not "every reported gap" — when the gate exempted an unclosable one. An older copy still offers `eso.mode`, which the evidence gate does not read, and still tells the reader to close gaps nothing can close.',
    'guard-shell.py': 'The shell guard shares the tier and attestation readers with guard-write; an older copy can disagree with the write guard about the same verdict.',
    'pre-tool-use.py': 'Antigravity entry point; an older copy may not defer to guard-write for the write event.',
};

export function resolveTemplatesDir(env = process.env) {
    return path.join(env.HARNESS_PROFILES_DIR || PROFILES_DIR_DEFAULT, 'templates', 'hooks');
}

function sha256File(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch {
        return null;
    }
}

/**
 * A consumer guard is "customised" when it differs **and** carries something the shipped template
 * never writes: an operator marker, or an import/def the template does not have. We do not try to
 * diff semantics — that would be a heuristic, and a heuristic here would either hide a stale guard or
 * nag about a deliberate one.
 */
function looksCustomised(text, templateText) {
    if (/HARNESS: customised\b|HARNESS: operator-owned\b/i.test(text)) return true;
    const shippedDefs = new Set([...templateText.matchAll(/^def ([a-z_][\w]*)/gm)].map((m) => m[1]));
    for (const m of text.matchAll(/^def ([a-z_][\w]*)/gm)) {
        if (!shippedDefs.has(m[1])) return true;
    }
    return false;
}

/**
 * @param {string} root consumer root
 * @param {{ templatesDir?: string }} [opts] `templatesDir` for tests; production resolves the shipped one
 * @returns {{
 *   status: 'current'|'stale'|'customised'|'not-applied',
 *   detail: string,
 *   behind: { file: string, tree: string, consequence: string }[],
 *   customised: string[],
 *   trees: { id: string, wired: boolean, guards: string[] }[],
 * }}
 */
export function checkGuardFreshness(root, opts = {}) {
    const templatesDir = opts.templatesDir || resolveTemplatesDir();
    const trees = TREES.map((t) => ({
        id: t.id,
        wired: fs.existsSync(path.join(root, t.wiring)),
        guards: GUARDS.filter((g) => fs.existsSync(path.join(root, t.hooks, g))),
    }));

    const present = trees.flatMap((t) => t.guards.map((g) => ({ tree: t.id, file: g })));
    if (!present.length) {
        return {
            status: 'not-applied',
            detail: 'no guard file in any tree — H1 fails on wiring; run ./provision.sh <id>',
            behind: [],
            customised: [],
            trees,
        };
    }

    const behind = [];
    const customised = [];
    for (const { tree, file } of present) {
        const onDisk = path.join(root, TREES.find((t) => t.id === tree).hooks, file);
        const template = path.join(templatesDir, file);
        const shippedHash = sha256File(template);
        if (!shippedHash) continue; // template not shipped in this build: nothing to compare against
        if (sha256File(onDisk) === shippedHash) continue;
        let text = '';
        let templateText = '';
        try {
            text = fs.readFileSync(onDisk, 'utf8');
            templateText = fs.readFileSync(template, 'utf8');
        } catch {
            /* unreadable counts as behind — it cannot be verified */
        }
        if (text && looksCustomised(text, templateText)) customised.push(`${tree}:${file}`);
        else behind.push({ file, tree, consequence: SINCE[file] || 'differs from the shipped guard' });
    }

    if (behind.length) {
        const names = behind.map((b) => `${b.tree}/hooks/${b.file}`).join(', ');
        return {
            status: 'stale',
            detail: `${names} differ from the shipped guard — this consumer runs an older gate than the product it is installed from. Sync it (host-pack sync-guards).`,
            behind,
            customised,
            trees,
        };
    }
    if (customised.length) {
        return {
            status: 'customised',
            detail: `operator-owned guard: ${customised.join(', ')} — not compared against the template`,
            behind,
            customised,
            trees,
        };
    }
    return {
        status: 'current',
        detail: `guards match the shipped templates (${present.map((p) => `${p.tree}/${p.file}`).join(', ')})`,
        behind: [],
        customised: [],
        trees,
    };
}
