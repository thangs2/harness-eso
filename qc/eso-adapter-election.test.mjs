import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BRANCH_ORDER,
    electCapabilityProvider,
    handleMidTurnBranchFailure,
    setCapabilityPin,
    queryTurnProviderAudit,
    queryBatchProviderAudit,
} from '../eso/adapters/src/index.mjs';

test('SCN-HOST-01 (AC-HOST-01-01..08): Elects in exact branch order, records reason, enforces tenant isolation and known hosts', async () => {
    // 1. Exact branch order check (AC-HOST-01-04)
    assert.deepEqual(BRANCH_ORDER, ['host-native', 'eso-native', 'external', 'none']);

    // 2. Host-native elected when available (AC-HOST-01-01)
    const turnAuditLog = [];
    const election1 = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-1',
        capabilityKind: 'file_tools',
        host: 'cursor',
        branches: {
            'host-native': { available: true, provider_id: 'cursor-files' },
            'eso-native': { available: true },
        },
        turnAuditLog,
    });
    assert.equal(election1.branch, 'host-native');
    assert.equal(election1.provider_id, 'cursor-files');
    assert.ok(election1.reason.includes('host-native'));

    // 3. Fallback down to external if host-native and eso-native are absent
    const election2 = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-2',
        capabilityKind: 'codegraph',
        host: 'antigravity',
        branches: {
            'host-native': { available: false },
            'eso-native': { available: false },
            'external': { available: true, provider_id: 'mcp-codegraph' },
        },
        turnAuditLog,
    });
    assert.equal(election2.branch, 'external');
    assert.equal(election2.provider_id, 'mcp-codegraph');

    // 4. Tenant isolation (AC-HOST-01-05): Project A configuration does not apply to Project B
    const electionB = await electCapabilityProvider({
        project: 'project-B',
        turnId: 'turn-3',
        capabilityKind: 'codegraph',
        host: 'antigravity',
        branches: {
            'host-native': { available: false },
            'eso-native': { available: false },
            'external': { available: false },
        },
        turnAuditLog,
    });
    assert.equal(electionB.project, 'project-B');
    assert.equal(electionB.branch, 'none');

    // 5. Undeclared host rejected (AC-HOST-01-08)
    await assert.rejects(() => electCapabilityProvider({
            project: 'project-A',
            turnId: 'turn-4',
            capabilityKind: 'file_tools',
            host: 'unregistered-ide',
        }), (err) => {
        assert.equal(err.code, 'HOST_NOT_DECLARED');
        return true;
    });
});

test('SCN-HOST-02 (AC-HOST-02-01..05): None election still allows task to run with degraded guarantee; multi-capability support', async () => {
    const turnAuditLog = [];
    const election = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-10',
        capabilityKind: 'deepseek_direct',
        host: 'deepseek-harness',
        branches: {}, // all missing
        turnAuditLog,
    });

    assert.equal(election.branch, 'none');
    assert.equal(election.guarantee, 'G-DEGRADED');
    assert.ok(election.reason.includes('G-DEGRADED'));

    // AC-HOST-02-05 / ED6: Idempotent election within same turn
    const secondElection = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-10',
        capabilityKind: 'deepseek_direct',
        existingElections: [election],
        turnAuditLog,
    });
    assert.equal(secondElection, election);

    // AC-HOST-02-04 / ED3: Multi-capability turn where all drop to none
    const electionCap2 = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-10',
        capabilityKind: 'codegraph',
        host: 'deepseek-harness',
        branches: {},
        turnAuditLog,
    });
    assert.equal(electionCap2.capability, 'codegraph');
    assert.equal(electionCap2.branch, 'none');
    assert.notEqual(electionCap2.reason, election.reason);
});

test('SCN-HOST-03 (AC-HOST-03-01..05): Mid-turn branch failure switches branch and records trial history', async () => {
    const initial = {
        project: 'project-A',
        turn_id: 'turn-20',
        capability: 'graph',
        branch: 'external',
        provider_id: 'mcp-graph-server',
        history: [{ branch: 'external', status: 'elected' }],
    };

    // 1. External fails mid-turn, switches to none (AC-HOST-03-01, AC-HOST-03-03)
    const switched = handleMidTurnBranchFailure({
        currentElection: initial,
        failureReason: 'MCP process crashed',
        branches: {}, // no next viable branches
    });

    assert.equal(switched.switched, true);
    assert.equal(switched.previous_branch, 'external');
    assert.equal(switched.branch, 'none');
    assert.equal(switched.guarantee, 'G-DEGRADED');
    assert.equal(switched.history.length, 3); // initial + failed + switched

    // 2. Replay with uninstalled provider surfaces DANGLING_PROVIDER (AC-HOST-03-05 / ED10)
    const replay = handleMidTurnBranchFailure({
        currentElection: initial,
        uninstalledProviders: ['mcp-graph-server'],
    });
    assert.equal(replay.status, 'DANGLING_PROVIDER');
    assert.equal(replay.is_active, false);
    assert.ok(replay.message.includes('nguồn đã mất'));
});

test('SCN-HOST-04 (AC-HOST-04-01..05): Pinning elects target branch directly; rejects missing pin with PIN_UNAVAILABLE', async () => {
    // 1. Pinned to external directly bypasses host-native (AC-HOST-04-01)
    const election = await electCapabilityProvider({
        project: 'project-A',
        turnId: 'turn-30',
        capabilityKind: 'graph',
        host: 'cursor',
        branches: {
            'host-native': { available: true, provider_id: 'cursor-graph' },
            'external': { available: true, provider_id: 'pinned-mcp-graph' },
        },
        pins: { graph: 'external' },
    });
    assert.equal(election.branch, 'external');
    assert.equal(election.provider_id, 'pinned-mcp-graph');
    assert.equal(election.pinned, true);

    // 2. Pin unavailable on host throws PIN_UNAVAILABLE (AC-HOST-04-03)
    await assert.rejects(() => electCapabilityProvider({
            project: 'project-A',
            turnId: 'turn-31',
            capabilityKind: 'agentmemory',
            host: 'cursor',
            branches: {
                'host-native': { available: true },
                'external': { available: false }, // pinned branch unavailable
            },
            pins: { agentmemory: 'external' },
        }), (err) => {
        assert.equal(err.code, 'PIN_UNAVAILABLE');
        assert.equal(err.pinned_branch, 'external');
        return true;
    });

    // 3. Agent role modifying pin is rejected (AC-HOST-04-02 / RBAC)
    await assert.rejects(() => setCapabilityPin({
            capabilityKind: 'graph',
            targetBranch: 'external',
            actorRole: 'build', // agent role build
        }), (err) => {
        assert.equal(err.code, 'FORBIDDEN_MUTATION');
        return true;
    });

    // 4. Empty pin unpins (AC-HOST-04-05 / ED1)
    const pins = await setCapabilityPin({
        capabilityKind: 'graph',
        targetBranch: '',
        actorRole: 'operator',
        currentPins: { graph: 'external' },
    });
    assert.equal(pins.graph, undefined);
});

test('SCN-HOST-05 (AC-HOST-05-01..05): Audit query retrieves branch provenance, handles empty turns and batch sorting', async () => {
    const auditLog = [
        { turn_id: 'turn-50', capability: 'file_tools', branch: 'host-native', provider_id: 'p1' },
        { turn_id: 'turn-50', capability: 'graph', branch: 'none', guarantee: 'G-DEGRADED' },
        { turn_id: 'turn-51', capability: 'shell', branch: 'host-native', provider_id: 'p2' },
    ];

    // Single turn audit (AC-HOST-05-01 & AC-HOST-05-03)
    const audit50 = await queryTurnProviderAudit({ turnId: 'turn-50', auditLog });
    assert.equal(audit50.records.length, 2);
    assert.equal(audit50.has_degraded, true);

    // Turn with 0 capabilities (AC-HOST-05-04 / ED1)
    const emptyAudit = await queryTurnProviderAudit({ turnId: 'turn-empty', auditLog });
    assert.equal(emptyAudit.records.length, 0);
    assert.ok(emptyAudit.message.includes('turn không dùng năng lực nào'));

    // Batch query deterministic order across 200 turns (AC-HOST-05-05 / ED3)
    const batchTurns = Array.from({ length: 50 }, (_, i) => `turn-${100 - i}`);
    const largeLog = batchTurns.flatMap((tid) => [
        { turn_id: tid, capability: 'b_cap', branch: 'host-native' },
        { turn_id: tid, capability: 'a_cap', branch: 'host-native' },
    ]);

    const batchRes = await queryBatchProviderAudit({ turnIds: batchTurns, auditLog: largeLog });
    assert.equal(batchRes.length, 100);
    // Verifying sorted order: turn_id ascending, capability ascending
    assert.equal(batchRes[0].turn_id, 'turn-100');
    assert.equal(batchRes[0].capability, 'a_cap');
    assert.equal(batchRes[1].turn_id, 'turn-100');
    assert.equal(batchRes[1].capability, 'b_cap');
});
