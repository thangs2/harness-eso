/**
 * Harness-surface governance (invariant B2, RFC 18 §3.6).
 *
 * An optimizer — a proposer that rewrites prompts, skills, subagents or hooks from behavioural
 * contrast — is useful, but it edits a *declared surface*. Two properties of that surface are not
 * negotiable:
 *
 *   - **the gate is outside it.** A record a guard trusts must not be writable by the party the
 *     guard gates (B2), so no editable glob may name a hook config the host actually runs. An
 *     optimizer that can edit `.codex/hooks.json` can delete the guard and still look conformant.
 *   - **always-on content is capped.** Every always-on token competes with the output budget, so a
 *     surface declares a ceiling and this check measures the real files rather than trusting it.
 *
 * Nothing here is inferred. Absent `harnessSurface` in `harness.config.json` the result is `skip`,
 * so a consumer that never opted into an editable surface keeps its current conformance answer.
 *
 * Shape (all keys optional except `surfaces`):
 *
 *   "harnessSurface": {
 *     "alwaysOnMaxTokens": 8000,
 *     "surfaces": [
 *       { "id": "codex", "root": ".",
 *         "hooksFile": ".codex/hooks.json",          // default from SURFACE_PRESETS[id]
 *         "alwaysOn": ["AGENTS.md"],                  // default from SURFACE_PRESETS[id]
 *         "editable": ["AGENTS.md", ".agents/skills/**"] }
 *     ]
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';
// Subpath, not the package root: the root re-exports the SQLite port, and the host pack bundles
// every module reachable from the core barrel (see `foundation/src/pure.mjs` for the same rule).
import { estimateTokens } from '@mu/harness-foundation/token-estimate';

/** Every always-on token competes with output; 8k is the ceiling the Codex surface already uses. */
export const DEFAULT_ALWAYS_ON_CAP = 8000;

/**
 * Facts about a host that the check should not have to be told: where the hook config lives and
 * which files are injected every turn. Whether anything is *editable* is never a preset — that is
 * a consumer claim, because it is the consumer that runs (or refuses to run) an optimizer.
 */
export const SURFACE_PRESETS = {
    codex: { hooksFile: '.codex/hooks.json', alwaysOn: ['AGENTS.md'] },
    // Cursor eager rules live in `.cursor/rules/*.mdc`; `token-diet` already budgets them, and the
    // default here stays empty so this check has exactly one job (the gate).
    cursor: { hooksFile: '.cursor/hooks.json', alwaysOn: [] },
    agents: { hooksFile: '.agents/hooks.json', alwaysOn: ['AGENTS.md'] },
    claude: { hooksFile: '.claude/settings.json', alwaysOn: ['CLAUDE.md'] },
};

/**
 * Translate one glob into an anchored RegExp. Supports `**`, `*` and `?` — enough for a surface
 * declaration, and deliberately not a dependency, because this runs inside a hook-adjacent probe.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                i += 1;
                if (pattern[i + 1] === '/') {
                    i += 1;
                    out += '(?:.*/)?';
                } else {
                    out += '.*';
                }
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '[^/]';
        } else {
            out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
        }
    }
    return new RegExp(`^${out}$`);
}

/**
 * Normalise a declared relative path without ever joining an escape onto the root.
 *
 * @param {string} rel
 * @returns {{ rel: string, error?: string }}
 */
export function normalizeSurfaceRel(rel) {
    const value = String(rel ?? '').trim().replace(/\\/g, '/');
    if (!value) return { rel: '', error: 'empty path' };
    if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
        return { rel: value, error: 'absolute path' };
    }
    if (value.split('/').includes('..')) return { rel: value, error: 'path escapes the root' };
    return { rel: value.replace(/^\.\//, '').replace(/\/+$/, '') };
}

/**
 * Read the consumer's surface declaration. Read-only, and tolerant of a broken config: a probe
 * that throws would hide the finding it exists to report.
 *
 * @param {string} root consumer root
 * @returns {object|null}
 */
export function readHarnessSurface(root) {
    try {
        const raw = fs.readFileSync(path.join(root, 'harness.config.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const declared = parsed?.harnessSurface;
        return declared && typeof declared === 'object' ? declared : null;
    } catch {
        return null;
    }
}

function countTokens(target) {
    let tokens = 0;
    let stat;
    try {
        stat = fs.statSync(target);
    } catch {
        return null;
    }
    if (stat.isFile()) return estimateTokens(fs.readFileSync(target, 'utf8'));
    if (!stat.isDirectory()) return null;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name === '__pycache__') continue;
        const nested = countTokens(path.join(target, entry.name));
        if (nested !== null) tokens += nested;
    }
    return tokens;
}

/**
 * @param {string} root consumer root
 * @param {object|null} config the `harnessSurface` object
 * @returns {{ status: 'pass'|'fail'|'skip', detail: string, cap: number, surfaces: object[], violations: object[] }}
 */
export function checkHarnessSurface(root, config) {
    const surfaces = Array.isArray(config?.surfaces) ? config.surfaces : [];
    if (!surfaces.length) {
        return {
            status: 'skip',
            detail: 'no harnessSurface declared — nothing claims an editable surface',
            cap: Number(config?.alwaysOnMaxTokens ?? DEFAULT_ALWAYS_ON_CAP),
            surfaces: [],
            violations: [],
        };
    }

    const cap = Number(config?.alwaysOnMaxTokens ?? DEFAULT_ALWAYS_ON_CAP);
    const rows = [];
    const violations = [];

    for (const surface of surfaces) {
        const id = typeof surface?.id === 'string' && surface.id ? surface.id : '(unnamed)';
        const preset = SURFACE_PRESETS[id] ?? {};
        const rootRel = normalizeSurfaceRel(surface?.root ?? '.');
        const hooksFile = normalizeSurfaceRel(surface?.hooksFile ?? preset.hooksFile ?? '');
        const alwaysOn = (Array.isArray(surface?.alwaysOn) ? surface.alwaysOn : preset.alwaysOn ?? []).map(
            (rel) => normalizeSurfaceRel(rel),
        );
        const editable = (Array.isArray(surface?.editable) ? surface.editable : []).map((rel) =>
            normalizeSurfaceRel(rel),
        );

        const row = { id, hooksFile: hooksFile.rel, editable: editable.map((e) => e.rel), alwaysOnTokens: 0, cap };
        if (rootRel.error) {
            violations.push({ kind: 'invalid-surface', surface: id, detail: `root: ${rootRel.error}` });
        }

        for (const [index, pattern] of editable.entries()) {
            if (pattern.error) {
                violations.push({
                    kind: 'invalid-surface',
                    surface: id,
                    detail: `editable[${index}] "${surface?.editable?.[index]}": ${pattern.error}`,
                });
                continue;
            }
            if (hooksFile.rel && globToRegExp(pattern.rel).test(hooksFile.rel)) {
                violations.push({
                    kind: 'gate-in-editable-surface',
                    surface: id,
                    detail:
                        `editable glob "${pattern.rel}" matches the hook config ${hooksFile.rel} — ` +
                        'an optimizer could delete or rewrite the guard (B2)',
                });
            }
        }

        let tokens = 0;
        let measured = false;
        for (const file of alwaysOn) {
            if (file.error) {
                violations.push({ kind: 'invalid-surface', surface: id, detail: `alwaysOn "${file.rel}": ${file.error}` });
                continue;
            }
            const counted = countTokens(path.join(root, rootRel.rel, file.rel));
            if (counted === null) continue;
            measured = true;
            tokens += counted;
        }
        row.alwaysOnTokens = tokens;
        row.measured = measured;
        if (measured && tokens > cap) {
            violations.push({
                kind: 'always-on-over-budget',
                surface: id,
                detail: `${tokens} always-on token(s) > cap ${cap}; every one of them competes with the output budget`,
            });
        }
        rows.push(row);
    }

    if (violations.length) {
        const first = violations[0];
        const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
        return {
            status: 'fail',
            detail: `${first.surface}: ${first.detail}${more}`,
            cap,
            surfaces: rows,
            violations,
        };
    }

    const tokenView = rows.filter((r) => r.measured).map((r) => `${r.id}=${r.alwaysOnTokens}/${r.cap}`);
    return {
        status: 'pass',
        detail:
            `${rows.length} surface(s) clean — gate outside the editable set` +
            (tokenView.length ? `; always-on ${tokenView.join(', ')}` : ''),
        cap,
        surfaces: rows,
        violations,
    };
}
