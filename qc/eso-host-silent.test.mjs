import test from 'node:test';
import assert from 'node:assert/strict';

import {
    handleMidTurnBranchFailure,
    ERROR_SILENT_SWITCH,
    ERROR_SILENT_NONE,
} from '../eso/adapters/src/election.mjs';

test('ESO-383 / B5: SILENT_SWITCH and SILENT_NONE constants exist', () => {
    assert.equal(ERROR_SILENT_SWITCH, 'SILENT_SWITCH');
    assert.equal(ERROR_SILENT_NONE, 'SILENT_NONE');
});

test('ESO-383 / B5: Missing failure reason or silent switch throws SILENT_SWITCH', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'host-native',
        provider_id: 'cursor-codegraph',
    };

    // 1. Missing failureReason throws SILENT_SWITCH
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: '',
                branches: { 'eso-native': { available: true } },
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_SWITCH');
            return true;
        }
    );

    // 2. silent: true throws SILENT_SWITCH
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: 'Socket timeout',
                branches: { 'eso-native': { available: true } },
                silent: true,
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_SWITCH');
            return true;
        }
    );
});

test('ESO-383 / B5: Silent fallback to none throws SILENT_NONE', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'external',
        provider_id: 'ext-cg',
    };

    // Attempting silent fallback to none
    assert.throws(
        () => {
            handleMidTurnBranchFailure({
                currentElection: election,
                failureReason: 'Provider uninstalled',
                branches: {}, // all next branches empty -> falls back to none
                silentNone: true,
            });
        },
        (err) => {
            assert.equal(err.code, 'SILENT_NONE');
            return true;
        }
    );
});

test('ESO-383 / B5: Non-silent mid-turn branch switch records record and reason explicitly', () => {
    const election = {
        turn_id: 'turn-1',
        capability: 'codegraph_query',
        branch: 'host-native',
        provider_id: 'cursor-codegraph',
        history: [{ branch: 'host-native', status: 'elected' }],
    };

    const res = handleMidTurnBranchFailure({
        currentElection: election,
        failureReason: 'Host CLI crashed',
        branches: {
            'eso-native': { available: true, provider_id: 'eso-codegraph' },
        },
    });

    assert.equal(res.switched, true);
    assert.equal(res.branch, 'eso-native');
    assert.equal(res.previous_branch, 'host-native');
    assert.ok(res.switch_record);
    assert.equal(res.switch_record.from, 'host-native');
    assert.equal(res.switch_record.to, 'eso-native');
    assert.equal(res.switch_record.reason, 'Host CLI crashed');
    assert.equal(res.switch_record.silent, false);
    assert.ok(res.history.some((h) => h.status === 'failed' && h.reason === 'Host CLI crashed'));
});
