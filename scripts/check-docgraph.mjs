#!/usr/bin/env node
/**
 * Is `.docgraph/docgraph.json` still an answer about *this* repo? (G-20)
 *
 * `.docgraph/` is gitignored build output — the same convention as `.codegraph/` — and unlike
 * codegraph it has **no daemon**. Codegraph auto-syncs on every MCP call; docgraph is rebuilt only
 * when a human remembers to type `docgraph build`. Nothing compared the two, so the index sat at
 * `2026-10-14` while `documents/` gained `06.concept-mission-vision.md`,
 * `09.gate-defect-register.md` and `10.feature-and-classification-map.md` — nine days of the exact
 * files `AGENTS.md` tells the agent to find with docgraph *first*. Every query in those turns hit a
 * corpus that did not contain them, fell through to grep, and the "docgraph first" rule was
 * silently false while every test stayed green.
 *
 * This is the same defect class as G-19: a probe that cannot go out of date reports the past as the
 * present. Two facts are checked, because either one alone is a false pass:
 *
 *   generation  every file the scope covers was already on disk when the index was built
 *               → `stale`. The index answers an older version of the repo; a doc added after the
 *                 build is invisible to every query that trusts it.
 *   coverage    the index's entry list contains exactly the paths the scope covers
 *               → `out-of-step`, reported with the difference. Neither direction is trusted
 *                 blindly: the walk reads `path:` / `ext:` / `exclude:` from `docgraph.scope`
 *                 itself, but the indexer applies its own traversal rules, so this is a warning
 *                 and only `--strict` fails on it.
 *
 * Exit code is 0 unless the index is stale, or `--strict` turns the warning into a failure.
 *
 * Usage:
 *   node scripts/check-docgraph.mjs [--strict] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE_FILE = 'docgraph.scope';
const INDEX_FILE = path.join('.docgraph', 'docgraph.json');

/** Walk-up discovery, matching `~/.docgraph/lib/scope.ts`: env var, then walk up for the scope file. */
function findRepoRoot(start) {
    if (process.env.DOCGRAPH_REPO) return path.resolve(process.env.DOCGRAPH_REPO);
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, SCOPE_FILE))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Parse `docgraph.scope` into the set of files the index is supposed to contain.
 *
 * The scope is an **allowlist** (`path:` roots) filtered by `ext:` and `exclude:` — not "every file
 * with these extensions". Walking the whole repo and comparing would report `comments/artifacts/`,
 * `packages/**` and `documents/08.archive/` as missing on a perfectly healthy index, so the roots
 * are honoured literally: a path is covered when it is a root or lives under one.
 *
 * Directive names are read from the file rather than assumed, so a scope that gains `exclude:` or a
 * new extension changes what this checker answers without changing this checker.
 */
export function parseScope(scopeText) {
    const directive = (name) => [
        ...scopeText.matchAll(new RegExp(`^\\s*${name}:(\\S+)\\s*$`, 'gm')),
    ].map((m) => m[1]);
    return {
        extensions: directive('ext'),
        roots: directive('path'),
        excludes: directive('exclude'),
    };
}

/** Minimal glob for the exclude forms the scope actually uses: `**` spans directories, `*` does not. */
function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            out += '.*';
            i += 1;
            if (glob[i + 1] === '/') i += 1;
        } else if (ch === '*') out += '[^/]*';
        else if (ch === '?') out += '[^/]';
        else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}

/** Is a repo-relative path inside the scope's allowlist and not excluded from it? */
export function isCovered(rel, scope) {
    const covered =
        scope.roots.some((root) => rel === root || rel.startsWith(`${root.replace(/\/$/, '')}/`));
    if (!covered) return false;
    if (!scope.extensions.some((ext) => rel.endsWith(ext))) return false;
    return !scope.excludes.some((pattern) => globToRegExp(pattern).test(rel));
}

function readIndex(root) {
    const file = path.join(root, INDEX_FILE);
    const wire = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(wire.entries) ? wire.entries : [];
    return {
        file,
        generatedAt: wire.generated_at,
        count: entries.length,
        entries: new Set(entries.map((e) => e.p)),
    };
}

/**
 * @param {string} root repo root
 * @param {{ extensions?: string[], skipDirs?: string[] }} [opts]
 */
export function checkDocgraphFreshness(root, opts = {}) {
    const scopePath = path.join(root, SCOPE_FILE);
    if (!fs.existsSync(scopePath)) {
        return { status: 'absent', detail: `no ${SCOPE_FILE} at ${root} — docgraph is not configured here` };
    }
    const scope = opts.scope ?? parseScope(fs.readFileSync(scopePath, 'utf8'));
    if (!scope.roots.length) {
        return { status: 'absent', detail: `${SCOPE_FILE} declares no \`path:\` roots — nothing is covered` };
    }

    let index;
    try {
        index = readIndex(root);
    } catch (err) {
        return { status: 'absent', detail: `no readable ${INDEX_FILE} — run: docgraph build (${err.message})` };
    }

    const generatedAt = Date.parse(index.generatedAt);
    if (!Number.isFinite(generatedAt)) {
        return { status: 'absent', detail: `${INDEX_FILE} has no parseable generated_at: ${index.generatedAt}` };
    }

    const newer = [];
    const covered = [];
    /* Walk the declared roots only. `path:README.md` names a file; walking it would throw. */
    const visit = (rel) => {
        const abs = path.join(root, rel);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
                if (dirent.name === '.git') continue;
                visit(rel ? `${rel}/${dirent.name}` : dirent.name);
            }
            return;
        }
        if (!isCovered(rel, scope)) return;
        covered.push(rel);
        if (stat.mtimeMs > generatedAt) newer.push(rel);
    };
    for (const declared of scope.roots) {
        const rel = declared.replace(/\/$/, '');
        if (fs.existsSync(path.join(root, rel))) visit(rel);
    }

    const missing = covered.filter((rel) => !index.entries.has(rel));
    const extra = [...index.entries].filter((rel) => !covered.includes(rel));
    const common = { generatedAt: index.generatedAt, newer: newer.sort(), missing: missing.sort(), extra, index };

    if (newer.length) {
        return {
            status: 'stale',
            detail: `${INDEX_FILE} was built ${index.generatedAt}; ${newer.length} covered file(s) changed after it`,
            ...common,
        };
    }
    if (missing.length || extra.length) {
        return {
            status: 'out-of-step',
            detail: `index holds ${index.count} entries, scope covers ${covered.length}`,
            ...common,
        };
    }
    return {
        status: 'current',
        detail: `${index.count} entries, built ${index.generatedAt}; nothing covered has changed since`,
        ...common,
    };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function main(argv) {
    const json = argv.includes('--json');
    const strict = argv.includes('--strict');
    const root = findRepoRoot(process.env.DOCGRAPH_REPO ? process.cwd() : ROOT);
    const report = root
        ? checkDocgraphFreshness(root)
        : { status: 'absent', detail: `no ${SCOPE_FILE} found — docgraph is not configured for this repo` };

    if (json) {
        console.log(
            JSON.stringify(
                {
                    status: report.status,
                    detail: report.detail,
                    generatedAt: report.generatedAt ?? null,
                    entries: report.index?.count ?? null,
                    newer: report.newer ?? [],
                    missing: report.missing ?? [],
                    extra: report.extra ?? [],
                },
                null,
                2,
            ),
        );
    } else {
        console.log(`docgraph freshness  ${root ?? '(no repo)'}`);
        console.log(`  status    ${report.status}`);
        console.log(`  detail    ${report.detail}`);
        const lines = [
            ['newer', report.newer],
            ['missing', report.missing],
            ['extra', report.extra],
        ];
        for (const [label, list] of lines) {
            const shown = (list ?? []).slice(0, 8);
            for (const file of shown) console.log(`  ${label.padEnd(9)} ${file}`);
            if ((list ?? []).length > shown.length) {
                console.log(`  ${label.padEnd(9)} … and ${list.length - shown.length} more`);
            }
        }
        if (report.status === 'stale' || report.status === 'out-of-step') console.log('  fix       docgraph build');
    }

    if (report.status === 'stale' || (strict && report.status !== 'current')) {
        console.error(`\ndocgraph index is ${report.status}; run: docgraph build`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
