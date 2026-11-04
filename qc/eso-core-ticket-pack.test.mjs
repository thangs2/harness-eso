import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    REQUIRED_PACK_SECTIONS,
    generateExecutionPack,
    setTicketDoneStatus,
    queryHistoricalPack,
} from '../eso/core/src/index.mjs';

test('SCN-TICKET-01 (AC-TICKET-01-01..07): Generates execution pack with 4 sections; enforces RBAC, verbatim keys, 200 ACs', () => {
    assert.deepEqual(REQUIRED_PACK_SECTIONS, ['ac', 'scope', 'verify', 'forbidden']);

    // 1. Happy path: complete ticket (AC-TICKET-01-01)
    const ticketData = {
        summary: 'Feature checkout',
        ac: ['AC-1', 'AC-2'],
        scope: ['src/checkout.mjs'],
        verify: 'bun test qc/checkout.test.mjs',
        forbidden: ['src/legacy/**'],
    };

    const packRes = generateExecutionPack({
        ticketKey: 'ESO-100',
        ticketData,
        source: 'jira',
    });

    assert.equal(packRes.status, 'ready');
    assert.equal(packRes.is_ready, true);
    assert.ok(packRes.content_hash);
    assert.equal(packRes.pack.verify_command, 'bun test qc/checkout.test.mjs');

    // 2. 200 ACs retained without truncation (AC-TICKET-01-05 / ED3)
    const largeAcs = Array.from({ length: 200 }, (_, i) => `AC-PERF-${i + 1}`);
    const largePack = generateExecutionPack({
        ticketKey: 'ESO-PERF',
        ticketData: { ...ticketData, ac: largeAcs },
    });
    assert.equal(largePack.pack.ac.length, 200);

    // 3. Verbatim ticket key preserving unusual casing (AC-TICKET-01-06 / ED9)
    const unusualKey = 'abc-12_custom';
    const keyPack = generateExecutionPack({
        ticketKey: unusualKey,
        ticketData,
    });
    assert.equal(keyPack.ticket_key, unusualKey);

    // 4. Agent role setting Done is forbidden (AC-TICKET-01-04 / RBAC)
    assert.throws(() => {
        setTicketDoneStatus({
            ticketKey: 'ESO-100',
            actorRole: 'build', // agent
        });
    }, (err) => {
        assert.equal(err.code, 'DONE_FORBIDDEN');
        return true;
    });

    // Operator setting Done succeeds
    const doneRes = setTicketDoneStatus({
        ticketKey: 'ESO-100',
        actorRole: 'operator',
    });
    assert.equal(doneRes.status, 'Done');

    // 5. Untraceable / orphan value in pack rejected (AC-TICKET-01-07)
    assert.throws(() => {
        generateExecutionPack({
            ticketKey: 'ESO-ORPHAN',
            ticketData: { ...ticketData, has_orphan_value: true, orphan_value: 'untraceable_scope' },
        });
    }, (err) => {
        assert.equal(err.code, 'ORPHAN_VALUE');
        return true;
    });
});

test('SCN-TICKET-02 (AC-TICKET-02-01..05): Incomplete ticket diagnostics; empty ticket lists all 4 missing sections, deleted parent', () => {
    // 1. Missing verify section (AC-TICKET-02-01)
    const missingVerify = generateExecutionPack({
        ticketKey: 'ESO-201',
        ticketData: {
            ac: ['AC-1'],
            scope: ['src/a.mjs'],
            forbidden: ['sdlc/**'],
        },
    });
    assert.equal(missingVerify.is_ready, false);
    assert.deepEqual(missingVerify.missing, ['verify']);

    // 2. Empty ticket with 0 fields lists all 4 missing sections (AC-TICKET-02-04 / ED1)
    const emptyTicket = generateExecutionPack({
        ticketKey: 'ESO-EMPTY',
        ticketData: {},
    });
    assert.equal(emptyTicket.is_ready, false);
    assert.deepEqual(emptyTicket.missing, ['ac', 'scope', 'verify', 'forbidden']);

    // 3. Ticket referencing deleted parent (AC-TICKET-02-05 / ED10)
    const deletedParentTicket = generateExecutionPack({
        ticketKey: 'ESO-CHILD',
        ticketData: {
            ac: ['AC-1'],
            scope: ['src/**'],
            verify: 'bun test',
            forbidden: ['sdlc/**'],
            parent: { id: 'ESO-PARENT-OLD', deleted: true },
        },
    });
    assert.equal(deletedParentTicket.is_ready, false);
    assert.ok(deletedParentTicket.missing.some((m) => m.includes('parent đã mất: ESO-PARENT-OLD')));
    assert.equal(deletedParentTicket.unknowns[0].kind, 'deleted_parent');
});

test('SCN-TICKET-03 (AC-TICKET-03-01..05): Ticket sources (jira, local, none); idempotency in single turn, deleted branch', () => {
    const validData = {
        ac: ['AC-1'],
        scope: ['src/**'],
        verify: 'bun test',
        forbidden: ['sdlc/**'],
    };

    // 1. Local file source (AC-TICKET-03-01)
    const localPack = generateExecutionPack({
        ticketKey: 'LOCAL-1',
        ticketData: validData,
        localFile: { path: '.harness/tickets/local-1.json' },
    });
    assert.equal(localPack.source, 'local');
    assert.equal(localPack.status, 'ready');

    // 2. No tool and no file -> source: none (AC-TICKET-03-02)
    const nonePack = generateExecutionPack({
        ticketKey: 'NONE-1',
        source: 'none',
        turnId: 'turn-99',
    });
    assert.equal(nonePack.source, 'none');
    assert.deepEqual(nonePack.missing, ['ticket-source']);

    // 3. Idempotent second call in same turn returns existing record (AC-TICKET-03-04 / ED6)
    const secondCall = generateExecutionPack({
        ticketKey: 'NONE-1',
        source: 'none',
        turnId: 'turn-99',
        existingTurnPacks: [nonePack],
    });
    assert.equal(secondCall, nonePack);

    // 4. Local file referencing deleted branch (AC-TICKET-03-05 / ED10)
    const deletedBranchPack = generateExecutionPack({
        ticketKey: 'LOCAL-OLD',
        ticketData: validData,
        localFile: { path: 'local.json', deleted_branch: 'feature/retired-branch' },
    });
    assert.equal(deletedBranchPack.source, 'local');
    assert.ok(deletedBranchPack.missing.some((m) => m.includes('nhánh/sprint đã mất')));
});

test('SCN-TICKET-04 (AC-TICKET-04-01..07): Historical pack query, hash verification, tamper/drift detection, dangling cites', () => {
    const originalPackBody = {
        ticket_key: 'ESO-HIST',
        source: 'jira',
        ac: ['AC-1', 'AC-2'],
        scope: ['src/app.mjs'],
        verify_command: 'bun test',
        forbidden: ['sdlc/**'],
    };

    const initialPack = generateExecutionPack({
        ticketKey: 'ESO-HIST',
        ticketData: originalPackBody,
    });

    const turnPackRecords = [
        {
            turn_id: 'turn-100',
            pack: initialPack.pack,
            content_hash: initialPack.content_hash,
        },
    ];

    // 1. Query by turn matching hash (AC-TICKET-04-01)
    const histRes = queryHistoricalPack({
        turnId: 'turn-100',
        turnPackRecords,
    });
    assert.equal(histRes.found, true);
    assert.equal(histRes.hash_matched, true);
    assert.equal(histRes.tampered, false);

    // 2. Tampered pack detected via hash mismatch (AC-TICKET-04-02)
    const tamperedRecords = [
        {
            turn_id: 'turn-101',
            pack: { ...initialPack.pack, scope: ['src/tampered.mjs'] },
            content_hash: initialPack.content_hash, // Old hash
        },
    ];
    const tamperedRes = queryHistoricalPack({
        turnId: 'turn-101',
        turnPackRecords: tamperedRecords,
    });
    assert.equal(tamperedRes.hash_matched, false);
    assert.equal(tamperedRes.tampered, true);

    // 3. AC modified after pack creation flagged as drift (AC-TICKET-04-06)
    const driftRes = queryHistoricalPack({
        turnId: 'turn-100',
        turnPackRecords,
        currentTicketData: { ac: ['AC-1', 'AC-2', 'AC-3_MODIFIED'] },
    });
    assert.equal(driftRes.ac_drift, true);

    // 4. Broken citation flagged dangling in unknowns without dropping row (AC-TICKET-04-07)
    const packWithBrokenCite = {
        turn_id: 'turn-102',
        pack: { ...initialPack.pack, cites: [{ path: 'docs/deleted.md', broken: true }] },
        content_hash: 'dummy',
    };
    const citeRes = queryHistoricalPack({
        turnId: 'turn-102',
        turnPackRecords: [packWithBrokenCite],
    });
    assert.equal(citeRes.unknowns.length, 1);
    assert.equal(citeRes.unknowns[0].kind, 'dangling_cite');

    // 5. Turn with 0 packs returns found: false (AC-TICKET-04-04 / ED1)
    const emptyTurnRes = queryHistoricalPack({
        turnId: 'turn-empty',
        turnPackRecords,
    });
    assert.equal(emptyTurnRes.found, false);
    assert.ok(emptyTurnRes.message.includes('turn không dùng pack nào'));
});
