/**
 * Stream budget for the `llm/stream` waterfall — the DSH-side defect this module exists to absorb.
 *
 * ## The defect (read from the runtime, then measured)
 *
 * 1. `idleWatchdog` arms one `streamIdleTimeoutMs` per stream **read**, so the wait for the *first*
 *    byte shares its budget with the gap between two later deltas. Those are different quantities: the
 *    first is ingest, the second is a transport stall.
 * 2. Nothing scales the budget by request size, so no single constant fits every request.
 * 3. The retry is `mode: normal` — a fresh request. A request killed at the watchdog pre-fills again,
 *    up to `maxRetries` times, and the user sees "5 minutes, then 5 more".
 * 4. river-ai sends `: keep-alive` SSE comments every ~12–15 s while a request waits (probe-measured:
 *    4–8 per cold request). `eventsource-parser` drops comments and `pulse()` runs only on chunks, so
 *    **"waiting" and "dead" are indistinguishable** to DSH. That is the root defect.
 *
 * ## What is actually slow (probe-measured, river probe, 12 measured requests + 1 smoke, 2026-11-06)
 *
 * | prompt tokens | prompt cache | first byte |
 * |---|---|---|
 * | 4.3k (smoke) | hit | 2.2–2.7 s |
 * | 85k | miss | 49 / 56 / 67 s (effort high / max / none) |
 * | 213k | miss | 69.7 s |
 * | 427k | partial miss (213k cached) | 121 s |
 * | 427k | hit | 7.3 s (5.8 / 12.0 s with two in flight) |
 *
 * Prompt size is therefore *not* what makes a request slow: a cached 427k prompt answers in seconds,
 * and effort barely moves the first byte. A cache *miss* costs 50–120 s almost regardless of size.
 * The 200–300 s waits that motivated this module are **provider stalls** — derived not from this probe
 * but from the session logs of that evening (recorded chunk timestamps at 455–506k prompts: 204, 232,
 * 274, 278, 281 s), where two independent sessions stalled in the same minute while the account was
 * answering 88 × 429. A stall cannot be waited out, so the budget must fail it **earlier** than the
 * 300 s default and let the retry (cheap: the prompt cache is still warm) recover.
 *
 * ## The policy
 *
 * - first byte: `base + tokens × perThousandTokensMs`, capped;
 * - between chunks: a tight constant, because a stream silent for 90 s after content started is dead;
 * - a breach yields the same terminal `finish` chunk the adapter would have produced (`code: TIMEOUT`),
 *   so the existing retry policy joins in and no new failure mode is invented;
 * - every failure inside this module falls back to plain passthrough: a budget bug must never break a
 *   turn. Upstream failures keep their identity.
 *
 * ## Known limitation
 *
 * The guard cannot *cancel* the provider request: the waterfall hook receives no abort handle, so the
 * adapter's own watchdog is what actually closes the HTTP call. Failing early therefore leaves the
 * previous request alive until that net fires, and a retry can overlap it. Keep the route's
 * `streamIdleTimeoutMs` close to the guard's allowance (the DSH default, 300 s, is a reasonable net for
 * estimated tokens below ~700k — see the ceiling note) and keep `maxRetries` small on such a route.
 *
 * Pure and dependency-free by construction: it is bundled into `dist/eso-plugin.mjs`, which must stay
 * `node:*`-only (see the package README).
 */

/**
 * Defaults sized to the worst **healthy** wait in the table above (121 s at 427k partial miss), not to
 * the worst stall. Allowances are computed from *estimated* tokens (`chars / 3`), so the 427k probe
 * (≈2M chars) estimates ≈667k tokens ⇒ 290 s, and the 85k probe ⇒ 130 s: 1.9–2.4× the measured wait.
 */
export const DEFAULT_STREAM_BUDGET = {
    /** Fixed allowance every request gets before the first byte, whatever its size. */
    baseFirstByteMs: 90_000,
    /** Marginal allowance per 1k *estimated* prompt tokens. Zero is legal: it disables size scaling. */
    perThousandTokensMs: 300,
    /**
     * Ceiling. It binds at ≈900k *estimated* tokens ≈ 2.7M characters — about 600k tokens of ordinary
     * ASCII. Above that the route's 300 s net fires first, so the ceiling only matters when the net is
     * raised alongside it; it is not a promise that a 1M-token prompt is covered.
     */
    maxFirstByteMs: 360_000,
    /** Gap between two chunks once content started. Worst recorded gap in 2.1k steps: 1.8 s (62 s once). */
    interChunkMs: 90_000,
};

/**
 * Characters per token used to estimate the prompt.
 *
 * Three, not four, and deliberately on the generous side: dense prompts (code, tool JSON, Vietnamese
 * diacritics) run at 2–3 characters per token, so four under-counted them by 25–40% and produced an
 * allowance *below* the worst healthy wait. Over-counting only buys a slightly longer stall budget.
 * Calibration anchor: the 85k-token probe prompt (~4.5 chars/token ASCII filler) estimates ≈133k, and
 * the 427k-token probe estimates ≈667k — measured healthy waits were 49–67 s and 121 s respectively.
 */
const CHARS_PER_TOKEN = 3;

/** Node clamps a longer timer to the next tick; anything above this is not a duration we can honour. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A finite positive number within Node's timer range, else `undefined` — the only shape a timing field may have. */
function positive(value) {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return Math.min(value, MAX_TIMER_DELAY_MS);
}

/**
 * Coerce a configured budget into four usable timings.
 *
 * Row config is YAML: a hand-typed `baseFirstByteMs: 90s`, a `null`, or a missing field must not become
 * `NaN` — `setTimeout(NaN)` fires on the next tick and would turn *every* healthy turn into an instant
 * TIMEOUT. Anything unusable falls back to the default for that field.
 *
 * @param {unknown} budget - configured overrides, of unknown provenance.
 * @returns {typeof DEFAULT_STREAM_BUDGET} usable timings.
 */
export function normalizeBudget(budget) {
    const candidate = budget !== null && typeof budget === 'object' ? budget : {};
    const base = positive(candidate.baseFirstByteMs) ?? DEFAULT_STREAM_BUDGET.baseFirstByteMs;
    const scaled = Number.isFinite(candidate.perThousandTokensMs) && candidate.perThousandTokensMs >= 0
        ? Math.min(candidate.perThousandTokensMs, MAX_TIMER_DELAY_MS)
        : DEFAULT_STREAM_BUDGET.perThousandTokensMs;
    const ceiling = positive(candidate.maxFirstByteMs) ?? DEFAULT_STREAM_BUDGET.maxFirstByteMs;
    return {
        baseFirstByteMs: base,
        perThousandTokensMs: scaled,
        /* The ceiling may never sit below the floor, nor above what a timer can express. */
        maxFirstByteMs: Math.min(Math.max(ceiling, base), MAX_TIMER_DELAY_MS),
        interChunkMs: positive(candidate.interChunkMs) ?? DEFAULT_STREAM_BUDGET.interChunkMs,
    };
}

/**
 * Estimate request size from the prompt DSH hands the adapter.
 *
 * The hook sees the request *before* the adapter projects it, and that request carries no token count,
 * so this is a character-count estimate over messages, tool schemas and the system prompt. It is
 * deliberately optimistic in one direction only: an underestimate yields a smaller first-byte
 * allowance, still bounded below by `baseFirstByteMs`.
 *
 * @param {unknown} messages - `options.messages`.
 * @param {unknown} [tools] - `options.tools`; tool schemas ride in the prompt too. Loop-built requests
 *   also carry `options.toolHistory.tools`, which is not counted here: it can add ~10–30k tokens, which
 *   only makes the allowance slightly more conservative than the estimate suggests.
 * @param {unknown} [system] - `options.system`; a string or an array of text blocks.
 * @returns {number} estimated prompt tokens, never negative.
 */
export function estimatePromptTokens(messages, tools, system) {
    let characters = 0;
    if (Array.isArray(messages)) {
        for (const message of messages) {
            const content = message?.content;
            if (typeof content === 'string') {
                characters += content.length;
                continue;
            }
            if (!Array.isArray(content)) continue;
            for (const part of content) {
                /* Runtime reasoning blocks carry `text`, so one branch covers text and thinking. */
                if (typeof part?.text === 'string') characters += part.text.length;
                else if (typeof part?.arguments === 'string') characters += part.arguments.length;
            }
        }
    }
    if (typeof system === 'string') characters += system.length;
    else if (Array.isArray(system)) {
        for (const part of system) if (typeof part?.text === 'string') characters += part.text.length;
    }
    if (Array.isArray(tools) && tools.length > 0) {
        try {
            characters += JSON.stringify(tools).length;
        } catch {
            /* a cyclic tool schema is not our failure to report */
        }
    }
    return Math.max(0, Math.ceil(characters / CHARS_PER_TOKEN));
}

/**
 * The first-byte allowance for one request.
 *
 * @param {number} tokens - estimated prompt tokens ({@link estimatePromptTokens}).
 * @param {unknown} [budget] - overrides of unknown provenance; see {@link normalizeBudget}.
 * @returns {number} milliseconds to wait for the first byte.
 */
export function firstByteAllowanceMs(tokens, budget) {
    const merged = normalizeBudget(budget);
    const size = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    const scaled = merged.baseFirstByteMs + (size / 1000) * merged.perThousandTokensMs;
    return Math.min(
        merged.maxFirstByteMs,
        Math.max(merged.baseFirstByteMs, Math.min(Math.round(scaled), MAX_TIMER_DELAY_MS)),
    );
}

/**
 * Whether a chunk counts as the first byte.
 *
 * A `usage` chunk is bookkeeping: the adapter emits one with zeroed counters before a terminal error,
 * so treating it as content would hand a dead stream the inter-chunk allowance (the *short* one).
 *
 * @param {unknown} chunk - one value yielded by the adapter stream.
 * @returns {boolean} true for anything that carries content or opens a block.
 */
export function countsAsFirstByte(chunk) {
    if (chunk === null || typeof chunk !== 'object') return false;
    return chunk.type !== 'usage';
}

/**
 * One upstream read, with a synchronous throw from `next()` turned into a rejection so the caller has a
 * single code path. The returned promise rejects **only** with a failure the adapter produced.
 *
 * @param {AsyncIterator<unknown>} iterator - the adapter stream.
 * @returns {Promise<IteratorResult<unknown>>} the read.
 */
function readOnce(iterator) {
    try {
        return Promise.resolve(iterator.next());
    } catch (error) {
        return Promise.reject(error);
    }
}

/**
 * Race one upstream read against a deadline.
 *
 * @param {Promise<IteratorResult<unknown>>} read - from {@link readOnce}.
 * @param {number} ms - allowance for this read.
 * @param {(cancel: (() => void) | null) => void} track - receives the canceller, so a consumer that
 *   stops the stream can drop the pending timer instead of leaving it armed for the whole allowance.
 * @returns {Promise<{ timedOut: true } | { timedOut: false, result: unknown }>} which side won.
 */
function raceDeadline(read, ms, track) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const cancel = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        track(null);
    };
    const settled = read.then((result) => ({ timedOut: false, result }));
    // If the deadline wins, the orphaned read must not surface as an unhandled rejection.
    settled.catch(() => {});
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
        /* A background stream must not be the only reason the app stays alive. */
        if (typeof timer?.unref === 'function') timer.unref();
    });
    track(cancel);
    return Promise.race([settled, deadline]).finally(cancel);
}

/**
 * Stop the upstream without waiting for it.
 *
 * A real async generator queues `return()` behind its pending read, so awaiting this would block until
 * the *adapter's own* watchdog fires — exactly the latency this module exists to remove.
 *
 * @param {AsyncIterator<unknown>} iterator - the adapter stream.
 * @returns {void}
 */
function closeWithoutAwaiting(iterator) {
    try {
        const closing = iterator.return?.(undefined);
        void closing?.catch?.(() => {});
    } catch {
        /* closing is best-effort */
    }
}

/** A legal `for await` source that is not async-iterable: pass it through untouched. */
function passthroughSync(iterable) {
    return (async function* () {
        yield* iterable;
    })();
}

/** A well-formed `IteratorResult` from an unknown iterator. */
function isResult(value) {
    return value !== null && typeof value === 'object' && typeof value.done === 'boolean';
}

/**
 * The guard itself, written as a hand-rolled async iterator rather than an async generator.
 *
 * That shape is load-bearing: `return()` on an async generator is queued behind whatever it is awaiting,
 * so a consumer that stops mid-stream (user abort) would wait out the whole allowance before it could
 * leave. Here `return()` settles immediately and the pending read is abandoned to the adapter's net.
 *
 * @param {AsyncIterator<unknown>} iterator - the adapter stream.
 * @param {{
 *   tokens?: number,
 *   budget?: unknown,
 *   route?: string,
 *   onTimeout?: (detail: { phase: 'first-byte' | 'inter-chunk', allowanceMs: number, route?: string }) => void,
 *   onFallback?: (error: unknown) => void,
 * }} options - budget inputs and observability; both callbacks are optional and guarded.
 * @returns {AsyncIterableIterator<unknown>} the guarded stream.
 */
function guarded(iterator, options) {
    const budget = normalizeBudget(options.budget);
    const firstByteMs = firstByteAllowanceMs(options.tokens, budget);

    let started = false;
    /** Terminal chunk yielded, upstream finished, or consumer stopped: nothing more may be produced. */
    let closed = false;
    /** Set once the upstream stopped making sense; from then on its chunks pass through untimed. */
    let degraded = false;
    let reading = false;
    /** Dropper for the armed deadline timer, so `return()` can leave nothing behind. */
    let cancelDeadline = null;

    const report = (callback, payload) => {
        try {
            callback?.(payload);
        } catch {
            /* observation must not decide anything */
        }
    };

    /** Drop the armed deadline, if any: a stopped stream must not keep a timer alive. */
    const dropDeadline = () => {
        try {
            cancelDeadline?.();
        } catch {
            /* cancellation must not decide anything */
        }
        cancelDeadline = null;
    };

    /** Read the upstream with no budget at all — the degrade path. */
    async function readDirect() {
        let result;
        try {
            result = await iterator.next();
        } catch (upstream) {
            closed = true;
            throw upstream;
        }
        if (closed || !isResult(result) || result.done === true) {
            closed = true;
            return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
    }

    async function step() {
        const phase = started ? 'inter-chunk' : 'first-byte';
        const allowanceMs = started ? budget.interChunkMs : firstByteMs;

        let outcome;
        try {
            outcome = await raceDeadline(readOnce(iterator), allowanceMs, (cancel) => {
                cancelDeadline = cancel;
            });
        } catch (error) {
            /* Only the adapter's own read can reject here. */
            closed = true;
            throw error;
        }
        if (closed) return { done: true, value: undefined };

        if (outcome.timedOut === true) {
            closed = true;
            report(options.onTimeout, { phase, allowanceMs, route: options.route });
            closeWithoutAwaiting(iterator);
            return {
                done: false,
                value: {
                    type: 'finish',
                    reason: {
                        kind: 'error',
                        failure: {
                            code: 'TIMEOUT',
                            message: `stream budget: no ${phase === 'first-byte' ? 'first byte' : 'chunk'} within ${allowanceMs}ms${options.route ? ` (${options.route})` : ''}`,
                        },
                    },
                },
            };
        }

        const result = outcome.result;
        if (!isResult(result)) {
            /* The upstream stopped making sense: a defect on our side of the seam, so stop deciding. */
            degraded = true;
            report(options.onFallback, new TypeError('stream budget: the upstream iterator returned a malformed result'));
            return readDirect();
        }
        if (result.done === true) {
            closed = true;
            return { done: true, value: undefined };
        }
        if (!started && countsAsFirstByte(result.value)) started = true;
        return { done: false, value: result.value };
    }

    const stream = {
        [Symbol.asyncIterator]() {
            return stream;
        },
        async next() {
            if (closed) return { done: true, value: undefined };
            if (reading) throw new Error('stream budget: next() is already outstanding');
            reading = true;
            try {
                return degraded ? await readDirect() : await step();
            } finally {
                reading = false;
            }
        },
        async return() {
            if (!closed) {
                closed = true;
                dropDeadline();
                closeWithoutAwaiting(iterator);
            }
            return { done: true, value: undefined };
        },
        async throw(error) {
            if (!closed) {
                closed = true;
                dropDeadline();
                closeWithoutAwaiting(iterator);
            }
            throw error;
        },
    };
    return stream;
}

/**
 * Wrap an adapter chunk stream with the first-byte and inter-chunk policy.
 *
 * Validation is synchronous on purpose: the plugin wraps this call in `try`/`catch` and falls back to
 * the untouched stream, so a malformed argument must fail *here*, not on first iteration.
 *
 * @param {AsyncIterable<unknown>} chunks - `next()` from the `llm/stream` hook.
 * @param {object} [options] - see {@link guarded}.
 * @returns {AsyncIterableIterator<unknown>} the guarded stream.
 * @throws {TypeError} when `chunks` is neither async- nor sync-iterable.
 */
export function guardStream(chunks, options = {}) {
    if (chunks !== null && typeof chunks === 'object') {
        if (typeof chunks[Symbol.asyncIterator] === 'function') return guarded(chunks[Symbol.asyncIterator](), options);
        /* `for await` accepts a sync iterable; swallowing it as "empty" would lose the response. */
        if (typeof chunks[Symbol.iterator] === 'function') return passthroughSync(chunks);
    }
    throw new TypeError('guardStream expects an async (or sync) iterable of stream chunks');
}
