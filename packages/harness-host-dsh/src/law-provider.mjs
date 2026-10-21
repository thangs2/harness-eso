/**
 * DSH skills/instructions as a **native law provider** (RFC 18 M2).
 *
 * The host already has the organisational rules on disk — `AGENTS.md`, `.agents/skills/**` and
 * `sub_agents/**`. For a question that a skill answers verbatim, going out to docgraph is slower and
 * can miss the file entirely. This provider searches them locally and returns evidence with a real
 * file/line provenance.
 *
 * That shape is not DSH-specific: it is exactly what the Codex substrate materialises (and what
 * Harness² optimises), so a harness tree produced elsewhere is readable here without a second
 * provider.
 *
 * Its ceiling is deliberately low (0.5): skills are curated instructions, not a normative corpus with
 * coverage guarantees. A caller that needs contract-level sufficiency must still bind docgraph, which
 * is why the shipped `dsh-native` recipe keeps `law` explicit rather than native-first.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SKILL_ROOTS = ['.agents/skills', '.cursor/skills', '.claude/skills'];
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.agents/instructions.md', '.cursor/instructions.md'];

/*
 * Delegated agent roles. They are instructions a model reads before acting, so they are law for the
 * same reason a skill is — and a harness that was optimized elsewhere (Harness² writes
 * `sub_agents/<name>/AGENT.md`) carries its delegation rules here, not in `AGENTS.md`.
 */
export const SUBAGENT_ROOTS = ['sub_agents', '.agents/agents'];

function walk(dir, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(md|mdx)$/i.test(entry.name)) acc.push(full);
    }
    return acc;
}

function candidateFiles(root) {
    const files = [];
    for (const file of INSTRUCTION_FILES) {
        const full = path.join(root, file);
        if (fs.existsSync(full)) files.push(full);
    }
    for (const dir of SKILL_ROOTS) walk(path.join(root, dir), files);
    for (const dir of SUBAGENT_ROOTS) walk(path.join(root, dir), files);
    return files;
}

function termsOf(query) {
    return [...new Set(String(query).toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])];
}

/**
 * @param {{ root: string, maxSnippets?: number, maxChars?: number }} options
 */
export function createDshSkillsLaw(options = {}) {
    const { root, maxSnippets = 3, maxChars = 1200 } = options;
    if (!root) throw new Error('createDshSkillsLaw: root is required');

    return {
        id: 'native:dsh-skills',
        kinds: ['law'],
        capability: 'native',
        ceiling: 0.5,
        healthCheck() {
            return fs.existsSync(root);
        },
        async fetch(query) {
            const text = String(query?.text ?? query?.query ?? query ?? '').trim();
            const terms = termsOf(text);
            if (!terms.length) return { snippets: [], trace: 'dsh-skills:skip-empty' };

            const scored = [];
            for (const file of candidateFiles(root)) {
                let content;
                try {
                    content = fs.readFileSync(file, 'utf8');
                } catch {
                    continue;
                }
                const lines = content.split('\n');
                const hits = terms.reduce((n, term) => n + (content.toLowerCase().split(term).length - 1), 0);
                if (!hits) continue;
                const lineIndex = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
                if (lineIndex < 0) continue;
                const start = Math.max(0, lineIndex - 2);
                const snippet = lines.slice(start, lineIndex + 3).join('\n').slice(0, maxChars);
                scored.push({
                    hits,
                    relative: path.relative(root, file).split(path.sep).join('/'),
                    line: lineIndex + 1,
                    snippet,
                });
            }

            scored.sort((a, b) => b.hits - a.hits);
            const snippets = scored.slice(0, maxSnippets).map((item) => ({
                kind: 'law',
                text: item.snippet,
                query: text,
                provenance: { kind: 'file', file: item.relative, line: item.line },
                confidence: Math.min(0.5, item.hits / 10),
                meta: { provider: 'native:dsh-skills', hits: item.hits },
            }));

            return { snippets, trace: `dsh-skills:${snippets.length}` };
        },
    };
}
