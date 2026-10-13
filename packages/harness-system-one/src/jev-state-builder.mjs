import fs from 'node:fs';
import path from 'node:path';

function denyPatterns(policy) {
    const fromPolicy = policy?.privacy?.denyPathPatterns;
    if (Array.isArray(fromPolicy) && fromPolicy.length) return fromPolicy;
    return ['.env', 'credentials', 'session/*.json', 'typesafe.env'];
}

function globToRegExp(glob) {
    const g = String(glob || '').trim();
    if (!g) return null;
    const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(escaped, 'i');
}

function pathDenied(p, patterns) {
    const s = String(p || '').replace(/\\/g, '/');
    for (const pat of patterns) {
        const re = globToRegExp(pat);
        if (re && re.test(s)) return true;
    }
    return false;
}

function redactText(text, patterns) {
    let out = String(text || '');
    for (const pat of patterns) {
        if (pat.includes('env')) {
            out = out.replace(/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*=\s*[^\s]+/gi, '[redacted]');
        }
    }
    return out;
}

export function buildJevState(event, ctx, policy, extra = {}) {
    const patterns = denyPatterns(policy);
    const maxChars = policy?.privacy?.maxStateChars ?? 8000;

    const paths = [...(event.touchedPaths || []), ...(ctx.touchedPaths || [])]
        .map((p) => String(p).replace(/\\/g, '/'))
        .filter((p) => p && !pathDenied(p, patterns));
    const uniquePaths = [...new Set(paths)].slice(0, 40);

    const stem = redactText(event.userQueryStem ?? ctx.userQueryStem ?? '', patterns).slice(0, 500);
    const rules = event.hookMeta?.attachedRules ?? ctx.attachedRules ?? [];

    const l0 = extra.l0;
    const candidateLine =
        l0?.candidates?.length
            ? l0.candidates
                  .slice(0, 6)
                  .map((c) => `${c.bucket}:${c.score}`)
                  .join(', ')
            : '';

    const checks =
        extra.checkSummary?.length
            ? extra.checkSummary
                  .slice(0, 8)
                  .map((c) => `${c.id}=${c.status}`)
                  .join('; ')
            : '';

    const parts = [
        'harness-eso decision state',
        stem ? `query: ${stem}` : null,
        uniquePaths.length ? `paths: ${uniquePaths.join(', ')}` : null,
        rules.length ? `rules: ${rules.slice(0, 12).join(', ')}` : null,
        candidateLine ? `l0_candidates: ${candidateLine}` : null,
        l0?.winner ? `l0_winner: ${l0.winner.bucket}` : null,
        checks ? `checks: ${checks}` : null,
    ].filter(Boolean);

    let state = parts.join('\n');
    if (state.length > maxChars) {
        state = state.slice(0, maxChars - 20) + '\n…(truncated)';
    }
    return state;
}

export function loadTypesafeKeyFromRepo(cfg) {
    if (process.env.TYPESAFE_API_KEY && !process.env.TYPESAFE_API_KEY.includes('your_key_here')) {
        return process.env.TYPESAFE_API_KEY;
    }
    const root = cfg?.root;
    if (!root) return null;
    const envPath = path.join(root, 'installation', 'typesafe', 'typesafe.env');
    if (!fs.existsSync(envPath)) return null;
    try {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq <= 0) continue;
            const key = t.slice(0, eq).trim();
            const value = t.slice(eq + 1).trim();
            if (key === 'TYPESAFE_API_KEY' && value && !value.includes('your_key_here')) {
                return value;
            }
        }
    } catch {
        return null;
    }
    return null;
}
