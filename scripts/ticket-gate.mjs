#!/usr/bin/env node
/**
 * Hard gate for one ESO ticket. Law: sdlc/02/governance/01.standard/09.build-enforcement.md
 *
 * The gate answers one question: may this slice be built at all? A pack passes only when
 *   - it carries the contract fields (`E1`),
 *   - every `ac` resolves to exactly one `SCN` in the native RTM, and every `scn` names a test path
 *     (`E1`, Stage 7 — `sdlc/06.analysis/04.quality-control/15.native-rtm.md` is the source of truth
 *     for AC → SCN → test, so the pack references it instead of copying it),
 *   - every `red_packets[]` entry is a real Stage 7 packet under `sdlc/10.test/` that names the
 *     exact test file, the exact test name and a concrete expected failure, and holds no
 *     implementation code (`E2`),
 *   - the diff stays inside `allowed_files` and the pack's own `verify` commands pass (`E3`/`E4`).
 *
 * `acceptance_tests` and `test_hash` are gone: the Stage 7 deliverable is the RED packet, and that is
 * what the pack pins (`red_packet_hash`). Hashing test code pinned a file that does not exist yet —
 * the RTM records 0/37 created — and froze the half that is supposed to change on the way to GREEN.
 *
 * Usage:
 *   node scripts/ticket-gate.mjs ESO-401
 *   node scripts/ticket-gate.mjs ESO-401 --out /tmp/ESO-401-gate.json
 *   node scripts/ticket-gate.mjs --pack /tmp/complete.json --root /tmp/fixture --content-only
 *
 * `--content-only` runs the pack-contract checks and skips everything that needs a git HEAD (dirty
 * tree, diff scope, secrets, `verify` commands). It exists so a fixture pack can be judged without
 * committing it; it is never the verdict on a real slice.
 *
 * Exit: 0 pass · 1 gate failure · 2 bad input / environment.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPack, readPackFile, resolveRedPacket, verifyRedPacketIntegrity } from './check-test-integrity.mjs';

export const RTM_FILE = 'sdlc/06.analysis/04.quality-control/15.native-rtm.md';

/** Stage 5 packets. A pack names one BIP, and only a `READY` BIP may be built. */
export const BIP_DIR = 'sdlc/09.wbs/01.packets/01.bip';

/** The one status a BIP may have and still be built. Everything else is a decision not yet made. */
export const BUILDABLE_BIP_STATUS = 'READY';

/**
 * Fields a pack cannot be built without. `verify` is not in the ticket's minimum list but stays
 * mandatory: it is where E4 gets the commands it runs, and dropping it would leave the gate checking
 * paperwork only.
 */
const REQUIRED = [
    'ticket',
    'epic',
    'bip',
    'technical',
    'inv',
    'ac',
    'scn',
    'red_packets',
    'allowed_files',
    'forbidden',
    'verify',
    'base_commit',
];

/** Phrases that describe a hope, not a failure. A RED packet must say what assertion breaks. */
const VAGUE_FAILURE = [
    /\bwill fail\b/i,
    /\bsẽ fail\b/i,
    /\bfails? (somehow|later|at some point)\b/i,
    /\btodo\b/i,
    // `'pending'` là **giá trị trạng thái** của miền, không phải "test còn pending" — chỉ bắt khi
    // chữ đứng một mình, không nằm trong nháy. Bắt cả hai là báo sai đúng những packet cụ thể nhất.
    /(?<!['"\u0060])\bpending\b(?!['"\u0060])/i,
    /\bn\/a\b/i,
];

/** File hợp đồng của ticket — nằm ngoài phạm vi công việc của slice (xem scope loop). */
const PACK_FILE = /^sdlc\/09\.wbs\/00\.jira\/packs\/ESO-\d+\.json$/;

/** Stage 7 is a spec. A packet carrying implementation is a Stage 8 artefact filed in the wrong place. */
const CODE_FENCE = /^```(js|javascript|ts|typescript|tsx|jsx|mjs|cjs|py|python|cs|csharp|java|go|golang|rb|ruby|rs|rust|php)\b/im;
const CODE_MARKERS = [
    /^\s*export\s+(async\s+)?function\s+\w+/m,
    /^\s*export\s+class\s+\w+/m,
    /\bmodule\.exports\b/,
    /^\s*def\s+\w+\s*\(/m,
    /^\s*public\s+(final\s+)?class\s+\w+/m,
    /^\s*func\s+\(\w+\s+\*?\w+\)\s*\w+/m,
    /^\s*import\s+[\w{*][^\n]*\s+from\s+['"]/m,
];

export function globToRegExp(glob) {
    let out = '^';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                out += '.*';
                i += 1;
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '[^/]';
        } else if ('\\^$+?.()|{}[]'.includes(ch)) {
            out += `\\${ch}`;
        } else {
            out += ch;
        }
    }
    return new RegExp(`${out}$`);
}

export function matchesGlob(file, pattern) {
    return globToRegExp(pattern.replace(/\\/g, '/')).test(file.replace(/\\/g, '/'));
}

export function matchesAny(file, patterns) {
    return (patterns || []).some((pattern) => matchesGlob(file, pattern));
}

/**
 * Parse the native RTM table into AC → { scn, test, type }.
 * The row shape is `| \`AC-…\` | US | type | \`SCN-…\` | type | \`test path\` | entity | note |`; a row
 * whose test cell is not a backticked path is kept with `test: null` so the gate can say so instead
 * of silently treating the AC as covered.
 */
export function parseRtm(text) {
    const rows = new Map();
    for (const line of String(text || '').split('\n')) {
        const match = /^\|\s*`(AC-[A-Z0-9-]+)`\s*\|([^|]*)\|([^|]*)\|\s*`(SCN-[A-Z0-9-]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
        if (!match) continue;
        const test = /`([^`]+)`/.exec(match[6]);
        rows.set(match[1], {
            ac: match[1],
            scn: match[4],
            acType: match[3].trim(),
            scnType: match[5].trim(),
            test: test ? test[1].trim() : null,
        });
    }
    return rows;
}

/** AC ↔ SCN coverage. Missing rows fail closed: an AC the RTM never mentions is not covered. */
export function traceabilityFailures(pack, rtmRows) {
    const failures = [];
    const declared = Array.isArray(pack.scn) ? pack.scn : [];
    const acs = Array.isArray(pack.ac) ? pack.ac : [];
    const usedScn = new Set();

    if (new Set(acs).size !== acs.length) failures.push('DUPLICATE_AC');
    if (new Set(declared).size !== declared.length) failures.push('DUPLICATE_SCN');

    for (const ac of acs) {
        const row = rtmRows.get(ac);
        if (!row) {
            failures.push(`AC_NOT_IN_RTM:${ac}`);
            continue;
        }
        if (!row.scn) {
            failures.push(`AC_WITHOUT_SCN:${ac}`);
            continue;
        }
        usedScn.add(row.scn);
        if (!declared.includes(row.scn)) failures.push(`SCN_NOT_IN_PACK:${row.scn}`);
    }

    const byScn = new Map([...rtmRows.values()].map((row) => [row.scn, row]));
    for (const scn of declared) {
        const row = byScn.get(scn);
        if (!row) {
            failures.push(`SCN_NOT_IN_RTM:${scn}`);
            continue;
        }
        if (!row.test) failures.push(`SCN_WITHOUT_TEST_PATH:${scn}`);
        if (!usedScn.has(scn)) failures.push(`SCN_ORPHAN:${scn}`);
    }
    return failures;
}

/** The `phải thấy` cell of the packet's `R2` row — the true-RED expectation, or null. */
export function extractExpectedFailure(text) {
    const line = String(text || '')
        .split('\n')
        .find((entry) => /^\|\s*\*\*R2\*\*\s*\|/.test(entry));
    if (!line) return null;
    const cells = line.split('|');
    if (cells.length < 6) return null;
    const expected = cells[cells.length - 2].trim();
    return expected || null;
}

function normalise(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Implementation markers. Stage 7 packets are prose + tables; any of these means code leaked in. */
export function hasImplementationCode(text) {
    const body = String(text || '');
    if (CODE_FENCE.test(body)) return true;
    return CODE_MARKERS.some((marker) => marker.test(body));
}

/**
 * Every `red_packets[]` entry must be a real packet that agrees with the pack, field for field.
 * The pack states the test file, test name and expected failure; the packet must contain all three,
 * so a pack cannot claim a RED that the Stage 7 artefact does not actually specify.
 */
export function redPacketFailures(pack, root = process.cwd()) {
    const failures = [];
    const entries = pack.red_packets;
    if (!Array.isArray(entries) || entries.length === 0) return ['MISSING_RED_PACKETS'];

    for (const entry of entries) {
        if (typeof entry === 'string') {
            failures.push(`RED_PACKET_NOT_DESCRIBED:${entry}`);
            continue;
        }
        const label = entry?.packet || '<no packet path>';
        if (!entry?.packet) {
            failures.push('RED_PACKET_NO_PATH');
            continue;
        }
        // Reuse the integrity module's resolver: a RED packet lives under `sdlc/10.test/` or it is not
        // a RED packet, so both checks must reject the same paths.
        const located = resolveRedPacket(entry, root);
        if (!located.ok) {
            const reason = located.reason.startsWith('MISSING_RED_PACKET')
                ? located.reason
                : located.reason.replace(`:${entry.packet}`, `:${label}`);
            failures.push(reason);
            continue;
        }
        const body = readFileSync(located.absolute, 'utf8');

        if (!entry.test_file) failures.push(`RED_PACKET_NO_TEST_FILE:${label}`);
        else if (!body.includes(entry.test_file)) failures.push(`RED_PACKET_TEST_FILE_MISMATCH:${label}`);

        if (!entry.test_name) failures.push(`RED_PACKET_NO_TEST_NAME:${label}`);
        else if (!body.includes(entry.test_name)) failures.push(`RED_PACKET_TEST_NAME_MISMATCH:${label}`);

        const expected = extractExpectedFailure(body);
        if (!entry.expected_failure) {
            failures.push(`RED_PACKET_NO_EXPECTED_FAILURE:${label}`);
        } else if (!expected) {
            failures.push(`RED_PACKET_NO_EXPECTED_FAILURE:${label}`);
        } else if (normalise(entry.expected_failure) !== normalise(expected)) {
            failures.push(`RED_PACKET_EXPECTED_FAILURE_DRIFT:${label}`);
        }
        if (entry.expected_failure && normalise(entry.expected_failure).length < 24) {
            failures.push(`RED_PACKET_VAGUE_EXPECTED_FAILURE:${label}`);
        }
        if (entry.expected_failure && VAGUE_FAILURE.some((re) => re.test(entry.expected_failure))) {
            failures.push(`RED_PACKET_VAGUE_EXPECTED_FAILURE:${label}`);
        }
        if (hasImplementationCode(body)) failures.push(`RED_PACKET_CONTAINS_CODE:${label}`);
    }
    return failures;
}

/** YAML frontmatter, read as `key: value` — the BIP's `status` and `id` live there. */
export function parseFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
    if (!match) return {};
    const out = {};
    for (const line of match[1].split('\n')) {
        const entry = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (entry) out[entry[1]] = entry[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

/**
 * The BIP's §8 `OPEN` register: `| open_id | câu hỏi | ảnh hưởng | owner | nguồn đóng | chặn gì |`.
 * Only rows whose blocking cell bolds `chặn` are returned as blocking — `**không** chặn` and
 * "chặn **lúc chạy**" are not, so a runtime-only concern does not read as a design blocker.
 */
export function parseOpenRegister(text) {
    const opens = [];
    for (const line of String(text || '').split('\n')) {
        const id = /^\|\s*\*{0,2}`(OPEN-[A-Z0-9-]+)`\*{0,2}\s*\|/.exec(line);
        if (!id) continue;
        const cells = line.split('|').map((cell) => cell.trim());
        const owner = cells.length >= 7 ? cells[4] : '';
        const blocks = cells.length >= 7 ? cells[6] : '';
        opens.push({ id: id[1], owner, blocks, blocking: /\*\*chặn\*\*/.test(blocks) });
    }
    return opens;
}

/** Resolve `pack.bip` to a file: an explicit `{ id, file }`, a path, or a bare BIP id to look up. */
export function resolveBipFile(spec, root = process.cwd()) {
    const BIP_ID = /^BIP-[0-9]+_[0-9]+$/;
    if (spec && typeof spec === 'object') {
        if (!spec.file) return { ok: false, reason: 'BIP_NO_FILE' };
        const file = String(spec.file).replace(/\\/g, '/');
        if (file.includes('..') || !file.startsWith(`${BIP_DIR}/`)) {
            return { ok: false, reason: `BIP_OUTSIDE_BIP_DIR:${file}` };
        }
        return { ok: true, file, id: spec.id || null };
    }
    const value = String(spec || '').trim();
    if (!value) return { ok: false, reason: 'BIP_NO_FILE' };
    if (BIP_ID.test(value)) {
        const dir = resolve(root, BIP_DIR);
        if (!existsSync(dir)) return { ok: false, reason: `BIP_NOT_FOUND:${value}` };
        for (const name of readdirSync(dir).sort()) {
            if (!name.endsWith('.md')) continue;
            const candidate = `${BIP_DIR}/${name}`;
            const front = parseFrontmatter(readFileSync(resolve(root, candidate), 'utf8'));
            if (front.id === value) return { ok: true, file: candidate, id: value };
        }
        return { ok: false, reason: `BIP_NOT_FOUND:${value}` };
    }
    const file = value.replace(/\\/g, '/');
    if (file.includes('..') || !file.startsWith(`${BIP_DIR}/`)) {
        return { ok: false, reason: `BIP_OUTSIDE_BIP_DIR:${file}` };
    }
    return { ok: true, file, id: null };
}

/**
 * Read the BIP a pack points at and answer the only question the gate asks of it: is it `READY`?
 *
 * `READY-SPLIT` means Stage 5 deliberately left the slice open (a blocking `OPEN`), and `DRAFT` means
 * nobody has decided yet. Building either one produces code measured against a spec that is still
 * moving — the exact failure this gate exists to stop. The blocking `OPEN` ids and owners travel with
 * the verdict so the fix has an address.
 */
export function readBip(spec, root = process.cwd()) {
    const located = resolveBipFile(spec, root);
    if (!located.ok) return { ok: false, reason: located.reason };
    const absolute = resolve(root, located.file);
    if (!existsSync(absolute)) return { ok: false, reason: `BIP_NOT_FOUND:${located.file}` };

    const body = readFileSync(absolute, 'utf8');
    const front = parseFrontmatter(body);
    const tableStatus = /\|\s*\*\*status\*\*\s*\|\s*`([^`]+)`/.exec(body)?.[1] ?? null;
    const opens = parseOpenRegister(body);
    const blockingOpens = opens.filter((entry) => entry.blocking);
    const info = {
        id: front.id || located.id || null,
        file: located.file,
        status: front.status || null,
        blockingOpens,
    };

    if (!info.status) return { ok: false, ...info, reason: `BIP_STATUS_MISSING:${located.file}` };
    if (tableStatus && tableStatus !== info.status) {
        return { ok: false, ...info, reason: `BIP_STATUS_CONFLICT:${located.file} front=${info.status} table=${tableStatus}` };
    }
    if (located.id && info.id && located.id !== info.id) {
        return { ok: false, ...info, reason: `BIP_ID_MISMATCH:pack=${located.id} file=${info.id}` };
    }
    if (info.status !== BUILDABLE_BIP_STATUS) {
        return { ok: false, ...info, reason: `BIP_NOT_READY:${info.id}=${info.status}`, notReady: true };
    }
    return { ok: true, ...info, reason: null };
}

/**
 * `BIP_NOT_READY` carries the blocking `OPEN` ids and owners, because "not ready" without an address
 * is a dead end for whoever has to make it ready.
 */
export function bipFailures(pack, root = process.cwd()) {
    const verdict = readBip(pack.bip, root);
    if (verdict.ok) return { failures: [], bip: verdict };
    if (!verdict.notReady) return { failures: [verdict.reason], bip: verdict };
    const opens = (verdict.blockingOpens || [])
        .map((entry) => `${entry.id}[${entry.owner || 'owner:?'}]`)
        .join(',');
    const suffix = opens ? ` blocking=${opens}` : '';
    return { failures: [`${verdict.reason}${suffix}`], bip: verdict };
}

function run(cmd, { cwd = process.cwd(), timeout = 15 * 60 * 1000 } = {}) {
    const started = Date.now();
    const result = spawnSync(cmd, {
        cwd,
        shell: true,
        stdio: 'inherit',
        env: { ...process.env, CI: '1' },
        timeout,
    });
    return { cmd, exit: result.status ?? 1, ms: Date.now() - started };
}

function git(args, cwd = process.cwd()) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd }).trim();
}

function changedFiles(baseRef, cwd) {
    let base = baseRef || 'main';
    if (/^[0-9a-f]{7,40}$/i.test(String(base))) {
        // frozen ticket base: only commits after this point belong to the slice
    } else {
        try {
            base = git(['merge-base', 'HEAD', base], cwd);
        } catch {
            base = 'HEAD~1';
        }
    }
    return git(['diff', '--name-only', '--diff-filter=ACMRTD', `${base}..HEAD`], cwd)
        .split('\n')
        .filter(Boolean);
}

function checkSecrets(diffText) {
    const rules = [
        [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
        [/-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/, 'private key'],
        [/(JIRA_API_TOKEN|AGENTMEMORY_URL|API_TOKEN)\s*[:=]\s*['"][^'"]{8,}/i, 'hard-coded token'],
        [/password\s*[:=]\s*['"][^'"]{4,}/i, 'hard-coded password'],
    ];
    return rules.filter(([re]) => re.test(diffText)).map(([, label]) => label);
}

function readFlag(argv, name) {
    const index = argv.indexOf(name);
    return index > -1 ? argv[index + 1] : null;
}

function main() {
    const argv = process.argv.slice(2);
    const out = readFlag(argv, '--out');
    const packFile = readFlag(argv, '--pack');
    const root = resolve(readFlag(argv, '--root') || process.cwd());
    const contentOnly = argv.includes('--content-only');
    const ticketArg = argv.find((arg, index) => !arg.startsWith('--') && !['--out', '--pack', '--root'].includes(argv[index - 1]));

    if (!ticketArg && !packFile) {
        console.error('usage: node scripts/ticket-gate.mjs <ESO-nnn> [--out file]');
        console.error('       node scripts/ticket-gate.mjs --pack <file> [--root dir] [--content-only]');
        process.exit(2);
    }

    const failures = [];
    const warnings = [];
    let pack;
    let packSource;
    try {
        if (packFile) {
            const loaded = readPackFile(packFile);
            pack = loaded.pack;
            packSource = loaded.path;
        } else {
            pack = readPack(ticketArg);
            packSource = `${ticketArg} pack`;
        }
    } catch (error) {
        console.error(`GATE FAIL: ${error.message}`);
        process.exit(2);
    }
    const ticket = pack.ticket || ticketArg;

    if (ticketArg && pack.ticket !== ticketArg) {
        failures.push(`TICKET_MISMATCH pack=${pack.ticket} arg=${ticketArg}`);
    }
    for (const key of REQUIRED) {
        if (pack[key] === undefined || pack[key] === null || pack[key] === '') failures.push(`MISSING_PACK_FIELD:${key}`);
    }
    if (typeof pack.technical !== 'boolean') failures.push('TECHNICAL_FLAG_NOT_BOOLEAN');
    if (!Array.isArray(pack.inv)) failures.push('MISSING_INVARIANTS');
    else if (pack.inv.length === 0) warnings.push('INV_UNDECLARED: pack cites no constraint id — `BR-*` (business rule) hoặc `INV-*` (domain invariant), xem E1');
    if (!Array.isArray(pack.ac) || pack.ac.length === 0) {
        if (pack.technical !== true) failures.push('MISSING_AC_OR_TECHNICAL_FLAG');
    }

    // 1. Stage 5 must be READY. A slice still open (READY-SPLIT) or undecided (DRAFT) has no fixed
    //    target to build against, so the gate stops here before reading anything downstream.
    const bipVerdict = bipFailures(pack, root);
    failures.push(...bipVerdict.failures);

    // 2. Stage 7 trace: every AC has its SCN, every SCN has a test path (native RTM is the SoT).
    const rtmPath = resolve(root, RTM_FILE);
    let rtmRows = new Map();
    if (!existsSync(rtmPath)) {
        failures.push(`MISSING_RTM:${RTM_FILE}`);
    } else {
        rtmRows = parseRtm(readFileSync(rtmPath, 'utf8'));
        if (rtmRows.size === 0) failures.push(`RTM_EMPTY:${RTM_FILE}`);
        else failures.push(...traceabilityFailures(pack, rtmRows));
    }

    // 3. Stage 7 RED packets are real, exact, and carry no implementation.
    failures.push(...redPacketFailures(pack, root));

    // 4. Pack pins the RED packet it was handed, not the test code.
    const integrity = verifyRedPacketIntegrity(pack, root);
    if (!integrity.ok) failures.push(`RED_PACKET_INTEGRITY:${integrity.reason}`);

    const skipped = [];
    let files = [];
    if (contentOnly) {
        skipped.push('DIRTY_WORKTREE', 'DIFF_CHECK', 'SCOPE', 'DEPENDENCY', 'SECRET', 'VERIFY');
    } else {
        // 5. Clean HEAD only. No --no-verify, no dirty worktree.
        const dirty = git(['status', '--porcelain'], root);
        if (dirty) failures.push('DIRTY_WORKTREE: commit the slice before running the gate');
        try {
            git(['diff', '--check', `${pack.base_commit || 'HEAD~1'}..HEAD`], root);
        } catch {
            failures.push('DIFF_CHECK_WHITESPACE');
        }

        // 6. Scope.
        files = changedFiles(pack.base_commit || pack.base_ref, root);
        if (files.length === 0) failures.push('NO_DIFF');
        for (const file of files) {
            // Pack là **hợp đồng của ticket**, không phải việc của slice: `base_commit` chỉ có thể được
            // ghi sau khi mọi artifact trước-build đã commit, nên chính commit đó luôn nằm sau `base_commit`.
            // Không loại nó ra thì mọi ticket đều tự báo OUT_OF_SCOPE trên file của chính nó.
            if (PACK_FILE.test(file)) continue;
            if (!matchesAny(file, pack.allowed_files)) failures.push(`OUT_OF_SCOPE:${file}`);
            if (matchesAny(file, pack.forbidden)) failures.push(`FORBIDDEN_FILE:${file}`);
        }

        // 7. Dependency changes require explicit justification in the pack.
        if (files.some((file) => file === 'package.json' || file === 'bun.lock') && pack.allow_dependency !== true) {
            failures.push('DEPENDENCY_CHANGE_WITHOUT_ALLOW_DEPENDENCY');
        }
        if (pack.allow_dependency === true && !pack.dependency_reason) {
            failures.push('DEPENDENCY_REASON_REQUIRED');
        }

        // 8. Secret scan on the actual diff.
        let diffText = '';
        try {
            diffText = execFileSync('git', ['diff', `${pack.base_commit || 'HEAD~1'}..HEAD`], { encoding: 'utf8', cwd: root });
        } catch {
            diffText = '';
        }
        for (const secret of checkSecrets(diffText)) failures.push(`SECRET:${secret}`);
    }

    // 9. Commands: type/unit/RED→GREEN all come from the pack, never from prose.
    const commands = [];
    if (failures.length === 0 && !contentOnly) {
        for (const cmd of pack.verify) {
            const result = run(cmd, { cwd: root });
            commands.push(result);
            if (result.exit !== 0) failures.push(`VERIFY_FAILED:${cmd}`);
        }
    }

    const report = {
        ticket,
        epic: pack.epic,
        pack: packSource,
        mode: contentOnly ? 'content-only' : 'full',
        commit: (() => { try { return git(['rev-parse', 'HEAD'], root); } catch { return null; } })(),
        generatedAt: new Date().toISOString(),
        gate: failures.length === 0 ? 'PASS' : 'FAIL',
        failures,
        warnings,
        skipped,
        commands,
        stage5: {
            bip: bipVerdict.bip?.id ?? (typeof pack.bip === 'string' ? pack.bip : (pack.bip?.id ?? null)),
            file: bipVerdict.bip?.file ?? null,
            status: bipVerdict.bip?.status ?? null,
            ready: bipVerdict.failures.length === 0,
            blockingOpens: bipVerdict.bip?.blockingOpens ?? [],
        },
        stage7: {
            acs: Array.isArray(pack.ac) ? pack.ac.length : 0,
            scns: Array.isArray(pack.scn) ? pack.scn.length : 0,
            redPackets: Array.isArray(pack.red_packets) ? pack.red_packets.length : 0,
            rtmRows: rtmRows.size,
        },
        integrity: { hash: integrity.hash, files: integrity.files, pinned: integrity.pinned },
        changedFiles: files,
    };
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (out) writeFileSync(resolve(out), `${json}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) main();
