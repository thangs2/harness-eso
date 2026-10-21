import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunForPayload } from '../packages/harness-host-generic/src/pre-compact-cost-hook.mjs';

test('a continuation invocation does not write another cost checkpoint', () => {
    /*
     * Antigravity fires PreInvocation before every LLM call (invocationNum 0,1,2…), and this hook is
     * wired to it because the host has no PreCompact event. Writing one checkpoint per invocation
     * produced 20 checkpoints and 20 trace rows for a two-minute run, all without context data.
     */
    assert.equal(shouldRunForPayload({ invocationNum: 0 }), true, 'the first call of a turn is a checkpoint');
    assert.equal(shouldRunForPayload({ invocationNum: 1 }), false);
    assert.equal(shouldRunForPayload({ invocation_num: 7 }), false);
});

test('hosts with a real preCompact event are unaffected', () => {
    assert.equal(shouldRunForPayload({}), true);
    assert.equal(shouldRunForPayload({ trigger: 'auto' }), true);
    assert.equal(shouldRunForPayload({ invocationNum: null }), true);
});
