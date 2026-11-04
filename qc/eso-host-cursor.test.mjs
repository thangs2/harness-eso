import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostAdapter } from '../eso/core/src/host-contract.mjs';

test('ESO-378 / B3: Cursor host adapter dispatch applies real side effects (no stub)', () => {
    const cursor = createHostAdapter('cursor');

    // 1. Initial history is empty
    assert.deepEqual(cursor.getDispatchHistory(), []);

    // 2. Dispatch a file write action with custom execute handler
    let executionFlag = false;
    const actionResult = cursor.dispatch({
        type: 'file_write',
        payload: { path: 'src/main.ts', content: 'export const x = 1;' },
        execute() {
            executionFlag = true;
            return { bytesWritten: 25 };
        },
    });

    // Verify real side effect
    assert.equal(executionFlag, true);
    assert.equal(actionResult.executed, true);
    assert.equal(actionResult.host, 'cursor');
    assert.equal(actionResult.seq, 1);
    assert.equal(actionResult.side_effect.result.bytesWritten, 25);
    assert.equal(actionResult.side_effect.side_effect_applied, true);

    // Verify history recorded the side effect
    const history = cursor.getDispatchHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].seq, 1);
    assert.equal(history[0].type, 'file_write');
    assert.equal(history[0].required_capability, 'file_tools');
    assert.equal(history[0].assurance, 'NATIVE');

    // 3. Dispatch a second action without executor -> returns executed: false, error: 'NO_EXECUTOR'
    const cmdResult = cursor.dispatch({
        type: 'shell_command',
        payload: { cmd: 'bun test' },
    });
    assert.equal(cmdResult.seq, 2);
    assert.equal(cmdResult.executed, false);
    assert.equal(cmdResult.side_effect, null);
    assert.equal(cmdResult.error, 'NO_EXECUTOR');
    assert.equal(cursor.getDispatchHistory().length, 2);
    assert.equal(cursor.getDispatchHistory()[1].side_effect_applied, false);
    assert.equal(cursor.getDispatchHistory()[1].error, 'NO_EXECUTOR');

    // 4. Invalid action throws INVALID_ACTION
    assert.throws(
        () => cursor.dispatch(null),
        (err) => err.code === 'INVALID_ACTION'
    );
    assert.throws(
        () => cursor.dispatch({}),
        (err) => err.code === 'INVALID_ACTION'
    );
});

test('ESO-378 / B3: Unavailable capability on host throws CAPABILITY_UNAVAILABLE', () => {
    const dsh = createHostAdapter('deepseek-harness');

    // codegraph_query is UNAVAILABLE on deepseek-harness
    assert.throws(
        () => {
            dsh.dispatch({
                type: 'codegraph_query',
                payload: { symbol: 'MyClass' },
            });
        },
        (err) => {
            assert.equal(err.code, 'CAPABILITY_UNAVAILABLE');
            assert.equal(err.host, 'deepseek-harness');
            assert.equal(err.capability, 'codegraph_query');
            return true;
        }
    );
});
