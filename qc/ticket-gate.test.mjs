import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
    matchesGlob,
    matchesAny,
    parseRtm,
    extractExpectedFailure,
    hasImplementationCode,
    redPacketFailures,
} from '../scripts/ticket-gate.mjs';
import { hashRedPackets, verifyRedPacketIntegrity } from '../scripts/check-test-integrity.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RTM_SRC = join(REPO_ROOT, 'sdlc/06.analysis/04.quality-control/15.native-rtm.md');
const PACKET_REL = 'sdlc/10.test/01.graph-roslyn.tdd-unit.md';
const PACKET_SRC = join(REPO_ROOT, PACKET_REL);
const BIP_REL = 'sdlc/09.wbs/01.packets/01.bip/99.fixture.md';

/**
 * A BIP in the shape the gate reads: frontmatter `status`/`id`, the identity table that repeats the
 * status, and an `OPEN` register whose last column says whether the row blocks. `blocking` is spelled
 * the way the real packets spell it so the parser is exercised against their grammar, not a tidier one.
 */
function bipBody({ id = 'BIP-2_9', status = 'READY', opens = [] } = {}) {
    const rows = opens
        .map((open) => `| \`${open.id}\` | fixture question | fixture impact | ${open.owner || '`Lead`'} | — | ${open.blocking ? '**chặn** fixture AC' : '**không** chặn — fixture only'} |`)
        .join('\n');
    return `---
sot_doc_version: "0.1.0"
status: ${status}
phase: 6
id: ${id}
type: bip
---

# BIP fixture — \`${id}\`

## 1. Slice identity

| | |
|---|---|
| slice | **\`2.9\`** |
| **status** | \`${status}\` |

## 8. \`OPEN\` register

| \`open_id\` | câu hỏi | ảnh hưởng | owner | nguồn đóng | chặn gì |
|---|---|---|---|---|---|
${rows}
`;
}

/**
 * A throwaway repo root holding the artifacts the gate reads (the native RTM, one real Stage 7
 * packet, one BIP) plus a pack. Tests build fixtures here rather than editing the repo: a gate test
 * must not depend on — or damage — the operator's working tree.
 */
function fixture({
    packet = readFileSync(PACKET_SRC, 'utf8'),
    bip = bipBody(),
    writeBip = true,
} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'eso-gate-'));
    mkdirSync(join(root, 'sdlc/06.analysis/04.quality-control'), { recursive: true });
    mkdirSync(join(root, 'sdlc/10.test'), { recursive: true });
    mkdirSync(join(root, 'sdlc/09.wbs/01.packets/01.bip'), { recursive: true });
    writeFileSync(join(root, 'sdlc/06.analysis/04.quality-control/15.native-rtm.md'), readFileSync(RTM_SRC));
    writeFileSync(join(root, PACKET_REL), packet);
    if (writeBip) writeFileSync(join(root, BIP_REL), bip);
    return root;
}

/** A pack that the gate must accept: every field the contract names, filled from the real packet. */
function completePack(packetBody = readFileSync(PACKET_SRC, 'utf8')) {
    const testFile = /^\| \*\*test file\*\* \| `([^`]+)`/m.exec(packetBody)?.[1];
    const testName = /^\| \*\*test name\*\* \| `'([^']+)'`/m.exec(packetBody)?.[1];
    const expected = extractExpectedFailure(packetBody).replace(/\s+/g, ' ').trim();
    return {
        ticket: 'ESO-401',
        epic: 'ESO-12',
        bip: { id: 'BIP-2_9', file: BIP_REL },
        technical: false,
        inv: [],
        ac: ['AC-GRAPH-01-01'],
        scn: ['SCN-GRAPH-01'],
        red_packets: [
            { packet: PACKET_REL, test_file: testFile, test_name: testName, expected_failure: expected },
        ],
        allowed_files: ['eso/graph/**'],
        forbidden: ['qc/acceptance/**'],
        verify: ['bun test eso/graph'],
        base_commit: 'a'.repeat(40),
    };
}

function runGate(root, pack) {
    const packFile = join(root, 'pack.json');
    writeFileSync(packFile, JSON.stringify(pack, null, 2));
    const result = spawnSync(
        process.execPath,
        ['scripts/ticket-gate.mjs', '--pack', packFile, '--root', root, '--content-only'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const stdout = result.stdout || '';
    const json = stdout.slice(stdout.indexOf('{'));
    return { status: result.status, report: json ? JSON.parse(json) : null, stderr: result.stderr || '' };
}

test('gate scope globs match repository paths exactly', () => {
    assert.equal(matchesGlob('eso/graph/src/extractor.mjs', 'eso/graph/**'), true);
    assert.equal(matchesGlob('eso/graph', 'eso/graph/**'), false);
    assert.equal(matchesGlob('eso/control-plane/src/app.module.ts', 'eso/control-plane/src/app.module.ts'), true);
    assert.equal(matchesAny('qc/acceptance/ESO-401/test.mjs', ['qc/acceptance/**']), true);
    assert.equal(matchesAny('eso/graph/src/a.ts', ['eso/memory/**']), false);
});

test('RED packet hash is stable, moves with the packet, and fails closed when absent', () => {
    const root = fixture();
    const paths = [PACKET_REL];
    const first = hashRedPackets(paths, root);
    const second = hashRedPackets(paths, root);
    assert.equal(first.ok, true);
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);

    // The hash protects the Stage 7 spec, so editing the packet must change it.
    const packetPath = join(root, PACKET_REL);
    writeFileSync(packetPath, `${readFileSync(packetPath, 'utf8')}\n<!-- edited -->\n`);
    assert.notEqual(hashRedPackets(paths, root).hash, first.hash);

    const missing = hashRedPackets(['sdlc/10.test/99.nope.md'], root);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /MISSING_RED_PACKET/);

    assert.equal(hashRedPackets([], root).ok, false);
    assert.match(hashRedPackets([], root).reason, /NO_RED_PACKET/);

    // A RED packet outside sdlc/10.test/ is not a RED packet, however real the file is.
    writeFileSync(join(root, 'elsewhere.md'), 'x');
    assert.match(hashRedPackets(['elsewhere.md'], root).reason, /RED_PACKET_OUTSIDE_TEST_DIR/);
});

test('the RED packet hash pin is opt-in, and fails closed when it no longer matches', () => {
    const root = fixture();
    const fresh = hashRedPackets([PACKET_REL], root);

    // No pin: the pack is buildable, the gate just reports that nothing was pinned.
    const unpinned = verifyRedPacketIntegrity({ red_packets: [PACKET_REL] }, root);
    assert.equal(unpinned.ok, true);
    assert.equal(unpinned.pinned, false);
    assert.equal(unpinned.hash, fresh.hash);

    const pinned = verifyRedPacketIntegrity({ red_packets: [PACKET_REL], red_packet_hash: fresh.hash }, root);
    assert.equal(pinned.ok, true);
    assert.equal(pinned.pinned, true);

    // A packet edited after the pin was recorded must be refused, not re-hashed.
    const packetPath = join(root, PACKET_REL);
    writeFileSync(packetPath, `${readFileSync(packetPath, 'utf8')}\n<!-- edited -->\n`);
    const stale = verifyRedPacketIntegrity({ red_packets: [PACKET_REL], red_packet_hash: fresh.hash }, root);
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /RED_PACKET_HASH_MISMATCH/);

    const pending = verifyRedPacketIntegrity({ red_packets: [PACKET_REL], red_packet_hash: '<pending-verifier>' }, root);
    assert.equal(pending.ok, false);
    assert.match(pending.reason, /RED_PACKET_HASH_NOT_SET/);
});

test('a complete pack — SCN + RED packet + READY BIP — passes the gate', () => {
    const root = fixture();
    const { status, report } = runGate(root, completePack());
    assert.equal(report?.gate, 'PASS');
    assert.deepEqual(report.failures, []);
    assert.equal(status, 0);
    assert.equal(report.stage5.status, 'READY');
    assert.equal(report.stage5.ready, true);
    assert.equal(report.stage7.acs, 1);
    assert.equal(report.stage7.redPackets, 1);
});

test('a BIP that is READY-SPLIT blocks the build, and the failure names the blocking OPEN', () => {
    const root = fixture({
        bip: bipBody({
            status: 'READY-SPLIT',
            opens: [{ id: 'OPEN-GRAPH-SCHEMA-01', owner: '`data` (Stage 5 graph)', blocking: true }],
        }),
    });
    const { status, report } = runGate(root, completePack());
    assert.equal(status, 1);
    assert.equal(report.gate, 'FAIL');
    const failure = report.failures.find((entry) => entry.startsWith('BIP_NOT_READY'));
    assert.ok(failure, report.failures.join(','));
    assert.match(failure, /BIP_NOT_READY:BIP-2_9=READY-SPLIT/);
    assert.match(failure, /OPEN-GRAPH-SCHEMA-01/, 'the OPEN id must travel with the verdict');
    assert.match(failure, /data/, 'the OPEN owner must travel with the verdict');
    assert.equal(report.stage5.blockingOpens.length, 1);
    assert.equal(report.stage5.blockingOpens[0].id, 'OPEN-GRAPH-SCHEMA-01');
});

test('a BIP that is DRAFT blocks the build', () => {
    const root = fixture({ bip: bipBody({ status: 'DRAFT' }) });
    const { status, report } = runGate(root, completePack());
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((entry) => entry.startsWith('BIP_NOT_READY:BIP-2_9=DRAFT')),
        report.failures.join(','),
    );
});

test('a non-blocking OPEN does not stop a READY BIP from building', () => {
    // The register distinguishes "**chặn**" from "**không** chặn"; a runtime-only concern must not
    // read as a design blocker, or the gate would refuse work the BIP says is ready.
    const root = fixture({
        bip: bipBody({ status: 'READY', opens: [{ id: 'OPEN-API-GRAPH-04', owner: '`arch`', blocking: false }] }),
    });
    const { status, report } = runGate(root, completePack());
    assert.equal(status, 0, report.failures.join(','));
    assert.equal(report.stage5.blockingOpens.length, 0);
});

test('a pack whose BIP file is missing fails closed', () => {
    const root = fixture({ writeBip: false });
    const { status, report } = runGate(root, completePack());
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((entry) => entry.startsWith('BIP_NOT_FOUND')),
        report.failures.join(','),
    );
});

test('a pack whose BIP id disagrees with the file fails', () => {
    const root = fixture();
    const pack = completePack();
    pack.bip = { id: 'BIP-9_1', file: BIP_REL };
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((entry) => entry.startsWith('BIP_ID_MISMATCH')),
        report.failures.join(','),
    );
});

test('a BIP path outside sdlc/09.wbs/01.packets/01.bip/ is refused', () => {
    const root = fixture();
    writeFileSync(join(root, 'elsewhere.md'), bipBody({ status: 'READY' }));
    const pack = completePack();
    pack.bip = { id: 'BIP-2_9', file: 'elsewhere.md' };
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((entry) => entry.startsWith('BIP_OUTSIDE_BIP_DIR')),
        report.failures.join(','),
    );
});

test('a pack without a BIP fails', () => {
    const root = fixture();
    const pack = completePack();
    delete pack.bip;
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(report.failures.includes('MISSING_PACK_FIELD:bip'), report.failures.join(','));
});

test('a pack without SCN fails', () => {
    const root = fixture();
    const pack = completePack();
    delete pack.scn;
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.equal(report.gate, 'FAIL');
    assert.ok(report.failures.includes('MISSING_PACK_FIELD:scn'), report.failures.join(','));
});

test('a pack whose SCN does not cover its AC fails', () => {
    const root = fixture();
    const pack = completePack();
    pack.scn = ['SCN-GRAPH-02'];
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(report.failures.includes('SCN_NOT_IN_PACK:SCN-GRAPH-01'), report.failures.join(','));
    assert.ok(report.failures.includes('SCN_ORPHAN:SCN-GRAPH-02'), report.failures.join(','));
});

test('an AC the RTM does not cover fails', () => {
    const root = fixture();
    const pack = completePack();
    pack.ac = ['AC-GRAPH-99-99'];
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(report.failures.includes('AC_NOT_IN_RTM:AC-GRAPH-99-99'), report.failures.join(','));
});

test('a pack without RED packets fails', () => {
    const root = fixture();
    const pack = completePack();
    delete pack.red_packets;
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(report.failures.includes('MISSING_PACK_FIELD:red_packets'), report.failures.join(','));
    assert.ok(report.failures.includes('MISSING_RED_PACKETS'), report.failures.join(','));
});

test('a RED packet with no concrete expected failure fails', () => {
    const body = readFileSync(PACKET_SRC, 'utf8');
    const withoutR2 = body
        .split('\n')
        .filter((line) => !/^\|\s*\*\*R2\*\*\s*\|/.test(line))
        .join('\n');
    assert.ok(body.includes('| **R2** |'), 'the fixture packet must have had an R2 row to remove');
    assert.equal(extractExpectedFailure(withoutR2), null);

    const root = fixture({ packet: withoutR2 });
    const pack = completePack(body);
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((f) => f.startsWith('RED_PACKET_NO_EXPECTED_FAILURE')),
        report.failures.join(','),
    );
});

test('a pack whose expected failure drifted from the packet fails', () => {
    const root = fixture();
    const packetBody = readFileSync(PACKET_SRC, 'utf8');
    const pack = completePack(packetBody);
    pack.red_packets[0].expected_failure = 'AssertionError — something else entirely, honestly';
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((f) => f.startsWith('RED_PACKET_EXPECTED_FAILURE_DRIFT')),
        report.failures.join(','),
    );
});

test('a RED packet that points outside sdlc/10.test/ fails', () => {
    const root = fixture();
    writeFileSync(join(root, 'sdlc/10.test-placeholder.md'), 'x');
    const pack = completePack();
    pack.red_packets[0].packet = 'sdlc/10.test-placeholder.md';
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((f) => f.startsWith('RED_PACKET_OUTSIDE_TEST_DIR')),
        report.failures.join(','),
    );
});

test('a RED packet listed without its exact test identity fails', () => {
    const root = fixture();
    const pack = completePack();
    pack.red_packets = [PACKET_REL];
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((f) => f.startsWith('RED_PACKET_NOT_DESCRIBED')),
        report.failures.join(','),
    );
});

test('a RED packet carrying implementation code fails', () => {
    const withCode = `${readFileSync(PACKET_SRC, 'utf8')}\n\`\`\`ts\nexport function extract() { return []; }\n\`\`\`\n`;
    assert.equal(hasImplementationCode(withCode), true);
    assert.equal(hasImplementationCode(readFileSync(PACKET_SRC, 'utf8')), false);

    const root = fixture({ packet: withCode });
    const pack = completePack(withCode);
    const { status, report } = runGate(root, pack);
    assert.equal(status, 1);
    assert.ok(
        report.failures.some((f) => f.startsWith('RED_PACKET_CONTAINS_CODE')),
        report.failures.join(','),
    );
});

/**
 * All eight shipped packs build again. Graph `2.6…2.9` was blocked only while the graph runtime was SQLite;
 * ESO-447 migrated it to PostgreSQL and is now HIR, so the feature slices are ready to build.
 */
test('every shipped pack builds, and none fails for another reason', () => {
    // Danh sách cũ ghim **tám** ticket. Năm pack mới của sprint 8 lệch R2 mà test vẫn xanh — đúng kiểu
    // "xanh vì không nhìn". Quét **mọi** pack đang ship, và ghim rằng phép quét không rỗng.
    const packsDir = join(REPO_ROOT, 'sdlc/09.wbs/00.jira/packs');
    const tickets = readdirSync(packsDir)
        .filter((n) => /^ESO-\d+\.json$/.test(n))
        .map((n) => n.replace(/\.json$/, ''))
        .sort();
    assert.ok(tickets.length >= 14, `chỉ thấy ${tickets.length} pack — quét không phủ`);
    for (const ticket of tickets) {
        const result = spawnSync(process.execPath, ['scripts/ticket-gate.mjs', ticket, '--content-only'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        const report = JSON.parse((result.stdout || '{}').slice((result.stdout || '{}').indexOf('{')));
        assert.equal(report.stage5.status, 'READY', `${ticket} BIP status`);
        assert.equal(result.status, 0, `${ticket} must build: ${result.stdout}`);
        assert.deepEqual(report.failures, [], `${ticket}`);
    }
});

test('the RTM is the AC → SCN → test source the gate reads', () => {
    const rows = parseRtm(readFileSync(RTM_SRC, 'utf8'));
    assert.ok(rows.size >= 37, `expected at least 37 traceable ACs, saw ${rows.size}`);
    const row = rows.get('AC-GRAPH-01-01');
    assert.equal(row.scn, 'SCN-GRAPH-01');
    assert.match(row.test, /^qc\/acceptance\//);
    for (const entry of rows.values()) assert.ok(entry.test, `${entry.ac} must name a test path`);
});

test('gate fails closed on an unknown ticket', () => {
    const result = spawnSync(process.execPath, ['scripts/ticket-gate.mjs', 'ESO-999'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
});

test('a failure that names the pending STATE is concrete; only bare "pending" is vague', () => {
    // `'pending'` là giá trị trạng thái của miền (chờ owner duyệt), không phải "test còn pending".
    // Luật cũ bắt cả hai và báo sai đúng những packet cụ thể nhất — 2 packet của ESO-457 đã bị chặn.
    const packetWith = (cell) => {
        const lines = readFileSync(PACKET_SRC, 'utf8').split('\n');
        const i = lines.findIndex((l) => l.startsWith('| **R2**'));
        const cells = lines[i].split('|');
        cells[4] = ` ${cell} `;
        lines[i] = cells.join('|');
        return lines.join('\n');
    };

    const literal = packetWith(
        "`AssertionError` ở `SCN-GRAPH-05`: **actual** trả `status: 'pending'` · **expected** `status: 'pending'` cho bản ghi chờ owner duyệt, kèm `code` và lý do",
    );
    const rootLiteral = fixture({ packet: literal });
    assert.deepEqual(redPacketFailures(completePack(literal), rootLiteral), []);

    const vague = packetWith('`AssertionError` ở `SCN-GRAPH-05`: **actual** sẽ pending mãi thôi · **expected** viết lại sau');
    const rootVague = fixture({ packet: vague });
    const failures = redPacketFailures(completePack(vague), rootVague);
    assert.ok(
        failures.some((f) => f.startsWith('RED_PACKET_VAGUE_EXPECTED_FAILURE')),
        `phải bắt chữ pending trơ, thấy: ${failures.join(' · ')}`,
    );
});
