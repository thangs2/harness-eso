import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_STREAM_BUDGET,
    countsAsFirstByte,
    estimatePromptTokens,
    firstByteAllowanceMs,
    guardStream,
} from '../packages/harness-eso-dsh/src/route-budget.mjs';

/** A chunk stream the test drives: `{ value }`, `{ error }`, `{ stall: true }` or `{ weird: true }`. */
function scripted(steps) {
    const state = { returned: false, returnedAt: null };
    const stream = {
        [Symbol.asyncIterator]() {
            let index = 0;
            return {
                async next() {
                    const step = steps[index];
                    index += 1;
                    if (step === undefined) return { done: true, value: undefined };
                    if (step.stall === true) return new Promise(() => {});
                    if (step.weird === true) return { nonsense: true };
                    if (step.error !== undefined) throw step.error;
                    return { done: false, value: step.value };
                },
                async return() {
                    state.returned = true;
                    state.returnedAt = Date.now();
                    return { done: true, value: undefined };
                },
            };
        },
    };
    return { stream, state };
}

async function collect(chunks) {
    const out = [];
    for await (const chunk of chunks) out.push(chunk);
    return out;
}

/** Resolve to a sentinel if `promise` has not settled in time — used to prove a stream terminates. */
function orTimeout(promise, ms, sentinel = 'HUNG') {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(sentinel), ms))]);
}

const fastBudget = { baseFirstByteMs: 200, perThousandTokensMs: 0, maxFirstByteMs: 200, interChunkMs: 100 };

test('estimatePromptTokens counts text, tool arguments, reasoning and tool schemas', () => {
    const tools = [{ name: 'read', description: 'x'.repeat(50) }];
    const characters = 160 + JSON.stringify(tools).length;
    assert.equal(estimatePromptTokens(undefined), 0);
    assert.equal(estimatePromptTokens([]), 0);
    assert.equal(
        estimatePromptTokens(
            [
                { role: 'user', content: 'abcd'.repeat(10) },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'efgh'.repeat(10) },
                        /* Runtime reasoning blocks carry `text`; 40 characters here. */
                        { type: 'reasoning', text: 'ijkl'.repeat(10) },
                        { type: 'tool-call', arguments: 'mnop'.repeat(10) },
                        { type: 'image' },
                    ],
                },
            ],
            tools,
        ),
        /* Three characters per token: deliberately generous on dense prompts (see the module header). */
        Math.ceil(characters / 3),
    );
    /* A cyclic schema is not the estimator's problem to report. */
    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    assert.equal(estimatePromptTokens([{ role: 'user', content: 'abcd' }], [cyclic]), 2);
});

test('firstByteAllowanceMs scales with the request and never leaves its bounds', () => {
    assert.equal(firstByteAllowanceMs(0), DEFAULT_STREAM_BUDGET.baseFirstByteMs);
    assert.equal(firstByteAllowanceMs(Number.NaN), DEFAULT_STREAM_BUDGET.baseFirstByteMs);
    assert.equal(firstByteAllowanceMs(-5000), DEFAULT_STREAM_BUDGET.baseFirstByteMs);
    /* 90 s + 0.3 s per 1k estimated tokens. */
    assert.equal(firstByteAllowanceMs(500_000), 240_000);
    /* Near the 1M window the ceiling binds. */
    assert.equal(firstByteAllowanceMs(1_000_000), DEFAULT_STREAM_BUDGET.maxFirstByteMs);
    assert.equal(firstByteAllowanceMs(50_000_000), DEFAULT_STREAM_BUDGET.maxFirstByteMs);
});

test('a usage chunk is bookkeeping, not the first byte', () => {
    assert.equal(countsAsFirstByte({ type: 'usage', usage: {} }), false);
    assert.equal(countsAsFirstByte({ type: 'reasoning-delta', index: 0, text: 'x' }), true);
    assert.equal(countsAsFirstByte({ type: 'block-start', index: 0, blockType: 'text' }), true);
    assert.equal(countsAsFirstByte(null), false);
});

test('a stream that fits the budget passes through untouched', async () => {
    const { stream } = scripted([
        { value: { type: 'reasoning-delta', index: 0, text: 'a' } },
        { value: { type: 'text-delta', index: 1, text: 'b' } },
        { value: { type: 'finish', reason: { kind: 'stop' } } },
    ]);
    const out = await collect(guardStream(stream, { budget: fastBudget }));
    assert.deepEqual(out.map((chunk) => chunk.type), ['reasoning-delta', 'text-delta', 'finish']);
});

test('a missing first byte becomes the adapter’s own TIMEOUT finish chunk', async () => {
    const { stream, state } = scripted([{ stall: true }]);
    const seen = [];
    const out = await collect(
        guardStream(stream, {
            tokens: 500_000,
            route: 'river-ai/deepseek-ai/DeepSeek-V4.1-Flash-1017',
            budget: fastBudget,
            onTimeout: (detail) => seen.push(detail),
        }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'finish');
    assert.equal(out[0].reason.kind, 'error');
    assert.equal(out[0].reason.failure.code, 'TIMEOUT');
    assert.match(out[0].reason.failure.message, /first byte/);
    assert.deepEqual(seen.map((detail) => detail.phase), ['first-byte']);
    assert.equal(state.returned, true);
});

test('a real async generator with a pending read does not delay the terminal chunk', async () => {
    /*
     * The regression this module must not have: `return()` on an async generator is queued behind its
     * pending `await`, so awaiting the close would block until the *adapter's* watchdog fires — the very
     * latency the budget exists to remove. 40 ms budget, 600 ms proof of termination.
     */
    async function* pendingRead() {
        yield { type: 'text-delta', index: 0, text: 'a' };
        await new Promise(() => {});
    }
    const started = Date.now();
    const out = await orTimeout(
        collect(guardStream(pendingRead(), { budget: { ...fastBudget, interChunkMs: 40 } })),
        600,
    );
    assert.notEqual(out, 'HUNG', 'the guarded stream never terminated');
    assert.equal(out.at(-1).reason.failure.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test('an idle gap after content uses the tight inter-chunk allowance', async () => {
    const { stream } = scripted([{ value: { type: 'text-delta', index: 0, text: 'a' } }, { stall: true }]);
    const seen = [];
    const out = await collect(guardStream(stream, { budget: fastBudget, onTimeout: (detail) => seen.push(detail) }));
    assert.equal(out.at(-1).reason.failure.code, 'TIMEOUT');
    assert.equal(seen[0].phase, 'inter-chunk');
    assert.equal(seen[0].allowanceMs, fastBudget.interChunkMs);
});

test('a leading usage chunk leaves the generous first-byte allowance in force', async () => {
    /* interChunkMs (10) has elapsed, but only a usage chunk arrived: the wait is still the first byte. */
    const slow = {
        [Symbol.asyncIterator]() {
            let index = 0;
            return {
                async next() {
                    index += 1;
                    if (index === 1) return { done: false, value: { type: 'usage', usage: {} } };
                    if (index === 2) {
                        await new Promise((resolve) => setTimeout(resolve, 60));
                        return new Promise(() => {});
                    }
                    return { done: true, value: undefined };
                },
                async return() {
                    return { done: true, value: undefined };
                },
            };
        },
    };
    const seen = [];
    const out = await collect(
        guardStream(slow, {
            budget: { baseFirstByteMs: 300, maxFirstByteMs: 300, perThousandTokensMs: 0, interChunkMs: 10 },
            onTimeout: (detail) => seen.push(detail),
        }),
    );
    assert.equal(out[0].type, 'usage');
    assert.equal(seen[0]?.phase, 'first-byte');
});

test('an upstream failure keeps its identity instead of becoming a budget timeout', async () => {
    const failure = Object.assign(new Error('socket hang up'), { code: 'TRANSPORT' });
    const { stream } = scripted([{ error: failure }]);
    await assert.rejects(collect(guardStream(stream, { budget: fastBudget })), (error) => error === failure);
});

test('a malformed iterator result degrades to passthrough and stops instead of spinning', async () => {
    const { stream } = scripted([{ weird: true }, { weird: true }, { weird: true }]);
    const seen = [];
    const out = await collect(
        guardStream(stream, { budget: fastBudget, onFallback: (error) => seen.push(error) }),
    );
    assert.deepEqual(out, []);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]?.message), /malformed/);
});

test('a sync iterable is passed through instead of silently swallowed', async () => {
    const out = await collect(
        guardStream(
            [
                { type: 'text-delta', index: 0, text: 'a' },
                { type: 'finish', reason: { kind: 'stop' } },
            ],
            { budget: fastBudget },
        ),
    );
    assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish']);
});

test('something that is not a stream at all fails synchronously, so the plugin can fall back', () => {
    assert.throws(() => guardStream(null), TypeError);
    assert.throws(() => guardStream({}), TypeError);
    assert.throws(() => guardStream(42), TypeError);
});

test('a stopped consumer closes the upstream stream', async () => {
    const { stream, state } = scripted([
        { value: { type: 'text-delta', index: 0, text: 'a' } },
        { value: { type: 'text-delta', index: 0, text: 'b' } },
        { stall: true },
    ]);
    for await (const chunk of guardStream(stream, { budget: fastBudget })) {
        assert.equal(chunk.type, 'text-delta');
        break;
    }
    assert.equal(state.returned, true);
});

test('an unusable budget falls back to the defaults instead of cutting a healthy stream', async () => {
    /*
     * Row config is YAML: `baseFirstByteMs: 90s`, `maxFirstByteMs: null`, a missing field. A NaN here
     * would make `setTimeout` fire on the next tick and turn every healthy turn into an instant TIMEOUT.
     */
    for (const broken of [
        { baseFirstByteMs: '90s', maxFirstByteMs: null, perThousandTokensMs: '250', interChunkMs: '90s' },
        { baseFirstByteMs: undefined, perThousandTokensMs: undefined, maxFirstByteMs: undefined },
        { baseFirstByteMs: Number.NaN, interChunkMs: 0 },
        'not-an-object',
        null,
    ]) {
        const { stream } = scripted([
            { value: { type: 'text-delta', index: 0, text: 'a' } },
            { value: { type: 'finish', reason: { kind: 'stop' } } },
        ]);
        const out = await collect(guardStream(stream, { budget: broken }));
        assert.deepEqual(
            out.map((chunk) => chunk.type),
            ['text-delta', 'finish'],
            `budget ${JSON.stringify(broken)} produced ${JSON.stringify(out)}`,
        );
    }
    /* Normalization is the public seam too, so a direct caller gets the same guarantee. */
    assert.equal(firstByteAllowanceMs(0, { baseFirstByteMs: 'x' }), DEFAULT_STREAM_BUDGET.baseFirstByteMs);
    assert.equal(firstByteAllowanceMs(0, { baseFirstByteMs: 1000, maxFirstByteMs: 10 }), 1000);
});

test('the guard counts the system prompt, not only the messages', () => {
    const messages = [{ role: 'user', content: 'abcd' }];
    assert.equal(estimatePromptTokens(messages, [], 'e'.repeat(400)), Math.ceil(404 / 3));
    assert.equal(estimatePromptTokens(messages, [], [{ type: 'text', text: 'f'.repeat(40) }]), Math.ceil(44 / 3));
});

test('the estimator keeps a real margin over the worst measured healthy wait', async () => {
    /*
     * Calibration guard, not a unit test of arithmetic: the 427k-token probe prompt was ~2M characters of
     * ASCII filler and waited 121 s cold. Whatever the estimator says for that shape must leave headroom.
     */
    const probeLike = [{ role: 'user', content: 'a'.repeat(2_000_000) }];
    const allowance = firstByteAllowanceMs(estimatePromptTokens(probeLike));
    assert.ok(allowance >= 121_000 * 1.5, `allowance ${allowance}ms is thin against a 121 s healthy wait`);
    /* And a dense prompt (2 chars/token) at the same character count must not collapse either. */
    const dense = firstByteAllowanceMs(estimatePromptTokens([{ role: 'user', content: 'a'.repeat(1_000_000) }]));
    assert.ok(dense >= 121_000, `dense allowance ${dense}ms is below the measured healthy wait`);
});

test('after the terminal chunk the stream is inert, whatever the consumer does', async () => {
    const { stream } = scripted([{ stall: true }, { value: { type: 'text-delta', index: 0, text: 'late' } }]);
    const guarded = guardStream(stream, { budget: { ...fastBudget, interChunkMs: 30, baseFirstByteMs: 30 } });
    const first = await guarded.next();
    assert.equal(first.value.reason.failure.code, 'TIMEOUT');
    /* A caller that keeps polling must not get a second terminal chunk or a late delta. */
    assert.deepEqual(await guarded.next(), { done: true, value: undefined });
    /* Nor may a `.throw()` re-open it. */
    await assert.rejects(guarded.throw(new Error('caller gave up')));
    assert.deepEqual(await guarded.next(), { done: true, value: undefined });
});

test('stopping mid-read returns immediately and leaves no unhandled rejection', async () => {
    /*
     * User abort while a read is pending: an async-generator guard would queue `return()` behind that
     * read and hang for the whole allowance (measured once at 1232 ms with a 3000 ms allowance). This
     * shape must settle now, and the abandoned read must stay quiet **when it later rejects** — which is
     * what the 40 ms rejection below pins, instead of a read that never settles and can never reject.
     */
    let unhandled = 0;
    const onUnhandled = () => {
        unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
        async function* pendingRead() {
            yield { type: 'text-delta', index: 0, text: 'a' };
            await new Promise((_, reject) => {
                setTimeout(() => reject(new Error('socket closed after the consumer left')), 40);
            });
            yield { type: 'text-delta', index: 0, text: 'never' };
        }
        const guarded = guardStream(pendingRead(), {
            budget: { baseFirstByteMs: 3000, maxFirstByteMs: 3000, perThousandTokensMs: 0, interChunkMs: 3000 },
        });
        const first = await guarded.next();
        assert.equal(first.value.type, 'text-delta');
        const started = Date.now();
        assert.deepEqual(await guarded.return(), { done: true, value: undefined });
        assert.ok(Date.now() - started < 100, `return() took ${Date.now() - started}ms`);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(unhandled, 0);
});

test('a stopped stream drops its armed deadline instead of leaving it behind', async () => {
    /*
     * A read parked on a 5-minute allowance must not keep its timer after the consumer stops. The deadline
     * is `unref()`d (so it can never hold the loop), but clearing it on `return()` is what stops a stale
     * timeout from firing into a stream nobody reads — so this pins the clearTimeout, not the refcount.
     */
    const tally = { cleared: 0 };
    const realClear = globalThis.clearTimeout;
    const realSet = globalThis.setTimeout;
    globalThis.clearTimeout = (handle) => {
        tally.cleared += 1;
        return realClear(handle);
    };
    try {
        const budget = { baseFirstByteMs: 300_000, maxFirstByteMs: 300_000, perThousandTokensMs: 0, interChunkMs: 300_000 };
        const { stream } = scripted([{ stall: true }]);
        const guarded = guardStream(stream, { budget });
        const pending = guarded.next();
        await new Promise((resolve) => setImmediate(resolve));
        const afterArm = tally.cleared;
        await guarded.return();
        assert.ok(tally.cleared > afterArm, 'return() must clear the deadline timer');
        /*
         * The read that was already outstanding settles when the upstream does — the same contract every
         * async iterator has, and a path a `for await` loop never takes (it never awaits `next()` and
         * `return()` at once). What must not survive `return()` is the timer, which is what is asserted.
         */
        pending.catch(() => {});
    } finally {
        globalThis.clearTimeout = realClear;
        globalThis.setTimeout = realSet;
    }
});

test('a timing field beyond Node’s timer range is clamped, never handed to setTimeout', async () => {
    /* 3e9 would make Node fire the timer on the next tick — worse than no budget at all. */
    const allowance = firstByteAllowanceMs(0, { baseFirstByteMs: 3e9 });
    assert.ok(allowance > 0 && allowance <= 2_147_483_647);
    const { stream } = scripted([
        { value: { type: 'text-delta', index: 0, text: 'a' } },
        { value: { type: 'finish', reason: { kind: 'stop' } } },
    ]);
    const out = await collect(guardStream(stream, { budget: { baseFirstByteMs: 3e9 } }));
    assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish']);
});
