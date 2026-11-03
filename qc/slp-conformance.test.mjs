// ESO-34 · ESO-35 · ESO-36 — the Sprint-0 setup of the SLP working environment, **measured**.
//
// Why this file exists: the three tickets state their acceptance as commands (`ls .cursor/agents/*-runtime.md | wc -l` = 7,
// pairwise-disjoint `allowed_files`, a skill under 150 lines with a numbered gate order). A DoD nobody runs is a DoD that
// quietly stops being true the first time somebody adds a role or renames a folder — and a law without a check is advice.
// `sdlc/02.governance/04.agent-rules.md` §10 says a proposal must declare itself a proposal; this file is the other half:
// the part that fails when the declaration and the tree disagree.
//
// The one design decision worth defending: `fixbug` declares **no** static write surface. Two workers with static authority
// over the same path is exactly what SLP's disjointness exists to prevent, and `build` and `fixbug` both edit product code.
// So `fixbug` derives its surface from evidence (`audit.findings[].file` inside the failing slice). Comparing its empty set
// against the others is honest — the alternative, giving it `packages/` and calling the overlap "temporal", would be a check
// that reads green while the property it names is false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const AGENTS = path.join(ROOT, '.cursor', 'agents');
const AGENTS_MIRROR = path.join(ROOT, '.agents', 'agents');
const RULE = path.join(ROOT, '.cursor', 'rules', 'core.slp.mdc');
const RULE_MIRROR = path.join(ROOT, '.agents', 'rules', 'core.slp.md');
const SKILL = path.join(ROOT, '.cursor', 'skills', 'harness-engineering-team', 'SKILL.md');
const SKILL_MIRROR = path.join(ROOT, '.agents', 'skills', 'harness-engineering-team', 'SKILL.md');

/** The seven workers, in SLP order. A rename here is a rename of the law, not of a preference list. */
const ROLES = ['scout', 'plan', 'build', 'fixbug', 'verify', 'audit', 'qc'];
const REQUIRED_KEYS = ['name', 'description', 'status', 'layer', 'allowed_files', 'forbidden', 'returns'];

const read = (p) => readFileSync(p, 'utf8');

/** Frontmatter as text. Deliberately not a YAML parser: the files are ours and the shape is fixed by REQUIRED_KEYS. */
function frontmatter(text) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, 'worker file has no frontmatter');
    return m[1];
}

/** Scalar or list value of one key. `key: []` is an empty list, not the string "[]". */
function valueOf(fm, key) {
    const lines = fm.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at === -1) return undefined;
    const inline = lines[at].slice(key.length + 1).trim();
    if (inline === '[]') return [];
    if (inline) return inline;
    const out = [];
    for (const line of lines.slice(at + 1)) {
        const m = /^\s+-\s+"?([^"]+?)"?\s*$/.exec(line);
        if (!m) break;
        out.push(m[1]);
    }
    return out;
}

/** A declared path exists. Globs are checked at their static root — `packages/**` is satisfied by `packages/`. */
function pathExists(declared) {
    const root = declared.split('**')[0].replace(/\/$/, '');
    if (!root) return true;
    const abs = path.join(ROOT, root);
    return existsSync(abs);
}

const roleFiles = readdirSync(AGENTS).filter((n) => n.endsWith('-runtime.md'));
const roleOf = (file) => path.basename(file, '-runtime.md');

// ── ESO-35 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ESO-35: exactly 7 worker runtime files, and they are the 7 SLP roles', () => {
    assert.equal(roleFiles.length, 7, `tìm thấy ${roleFiles.length}: ${roleFiles.join(', ')}`);
    assert.deepEqual(roleFiles.map(roleOf).sort(), [...ROLES].sort());
});

test('ESO-35: every worker declares the same contract keys', () => {
    for (const file of roleFiles) {
        const fm = frontmatter(read(path.join(AGENTS, file)));
        for (const key of REQUIRED_KEYS) {
            assert.ok(valueOf(fm, key) !== undefined, `${file}: thiếu \`${key}\``);
        }
        assert.equal(valueOf(fm, 'name'), `${roleOf(file)}-runtime`, `${file}: name phải khớp tên file`);
        assert.equal(valueOf(fm, 'status'), 'active', `${file}: status phải là active`);
    }
});

test('ESO-35: the 7 allowed_files sets are pairwise disjoint', () => {
    const surfaces = new Map(
        roleFiles.map((file) => {
            const list = valueOf(frontmatter(read(path.join(AGENTS, file))), 'allowed_files');
            return [roleOf(file), Array.isArray(list) ? list : []];
        }),
    );
    for (let i = 0; i < roleFiles.length; i++) {
        for (let j = i + 1; j < roleFiles.length; j++) {
            const a = roleOf(roleFiles[i]);
            const b = roleOf(roleFiles[j]);
            const shared = surfaces.get(a).filter((p) => surfaces.get(b).includes(p));
            assert.deepEqual(shared, [], `${a} và ${b} cùng ghi ${shared.join(', ')}`);
        }
    }
    // Non-vacuous: a run where every pair is empty because nothing is declared would pass the loop above.
    const nonEmpty = [...surfaces.values()].filter((v) => v.length > 0).length;
    assert.ok(nonEmpty >= 4, `chỉ ${nonEmpty} worker khai allowed_files — kiểm này sẽ xanh một cách rỗng`);
});

test('ESO-35: fixbug has no static surface — it derives one from findings', () => {
    const fm = frontmatter(read(path.join(AGENTS, 'fixbug-runtime.md')));
    assert.deepEqual(valueOf(fm, 'allowed_files'), [], 'fixbug không được có allowed_files tĩnh');
    const derived = valueOf(fm, 'derived_allowed_files');
    assert.ok(Array.isArray(derived) && derived.length > 0, 'fixbug phải khai derived_allowed_files');
});

test('ESO-35: every declared path exists on disk', () => {
    for (const file of roleFiles) {
        const fm = frontmatter(read(path.join(AGENTS, file)));
        for (const key of ['allowed_files', 'allowed_read']) {
            const list = valueOf(fm, key);
            if (!Array.isArray(list)) continue;
            for (const declared of list) {
                assert.ok(pathExists(declared), `${file}: \`${key}\` trỏ tới ${declared} — không tồn tại`);
            }
        }
    }
});

test('ESO-35: the .cursor/agents and .agents/agents directories are exact mirrors', () => {
    assert.ok(existsSync(AGENTS_MIRROR), 'thiếu .agents/agents');
    const mirrorFiles = readdirSync(AGENTS_MIRROR).filter((n) => n.endsWith('-runtime.md') || n === 'README.md');
    assert.deepEqual(mirrorFiles.sort(), [...roleFiles, 'README.md'].sort());
    for (const file of mirrorFiles) {
        assert.equal(
            read(path.join(AGENTS_MIRROR, file)),
            read(path.join(AGENTS, file)),
            `${file} giữa .cursor/agents và .agents/agents không khớp`,
        );
    }
});

// ── ESO-34 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ESO-34: the SLP rule carries one allowed_files row per worker and names all 7', () => {
    assert.ok(existsSync(RULE), 'thiếu .cursor/rules/core.slp.mdc');
    const rule = read(RULE);
    const count = rule.split('\n').filter((l) => l.includes('allowed_files')).length;
    assert.ok(count >= 7, `core.slp.mdc chỉ có ${count} dòng nhắc allowed_files`);
    for (const role of ROLES) {
        assert.ok(rule.includes(`\`${role}\``), `core.slp.mdc không nhắc worker \`${role}\``);
    }
});

test('ESO-34: the Cursor rule and its .agents mirror are the same bytes', () => {
    assert.ok(existsSync(RULE_MIRROR), 'thiếu .agents/rules/core.slp.md');
    assert.equal(read(RULE_MIRROR), read(RULE), 'hai bản luật đã lệch — một trong hai đang nói dối');
});

test('ESO-34: AGENTS.md points at the rule, the skill and the worker folder', () => {
    const law = read(path.join(ROOT, 'AGENTS.md'));
    for (const ref of ['core.slp.mdc', 'harness-engineering-team', '.cursor/agents/']) {
        assert.ok(law.includes(ref), `AGENTS.md không trỏ tới ${ref}`);
    }
});

// ── ESO-36 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ESO-36: the skill fits its budget and both trees carry the same copy', () => {
    assert.ok(existsSync(SKILL), 'thiếu .cursor/skills/harness-engineering-team/SKILL.md');
    const lines = read(SKILL).split('\n').length;
    assert.ok(lines <= 150, `SKILL.md dài ${lines} dòng — ngân sách 150 (X5)`);
    assert.ok(existsSync(SKILL_MIRROR), 'thiếu bản .agents của skill');
    assert.equal(read(SKILL_MIRROR), read(SKILL), 'hai bản skill đã lệch');
});

test('ESO-36: the gate order is numbered and covers all 7 workers', () => {
    const skill = read(SKILL);
    const numbered = skill.split('\n').filter((l) => /^\d+\.\s\*\*/.test(l)).length;
    assert.ok(numbered >= 9, `chỉ ${numbered} gate được đánh số — Lead không đọc ra thứ tự`);
    assert.ok(skill.includes('core.slp.mdc'), 'skill không trỏ về luật');
    for (const role of ROLES) {
        assert.ok(skill.includes(role), `skill không nhắc worker ${role}`);
    }
});
