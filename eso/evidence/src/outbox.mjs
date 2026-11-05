/**
 * @mu/eso-evidence — Outbox Buffer & Ingest Pipeline (ESO-70 / US-EV-01 / Slice S1)
 *
 * Invariants & Architectural Rules:
 * - D-20: Outbox ghi cục bộ, ingest ship sau: đường ghi không chặn turn.
 *   Không bao giờ await network/database remote trong chu kỳ turn-path.
 * - INV-EV-01 / AC-EV-01-06: Idempotent batch insertion; re-submitting batches is safe.
 * - BR-06: Append-only evidence journal.
 * - Resilience: If target DB is offline or throws, items remain buffered for next retry.
 */

import { recordTurn } from './recorder.mjs';

/**
 * Creates an in-memory / local append-only outbox journal.
 */
export class OutboxBuffer {
    constructor({ maxEntries = 1000 } = {}) {
        this.maxEntries = maxEntries;
        this.queue = [];
        this.nextId = 1;
    }

    /**
     * Fast local synchronous enqueue — non-blocking for turn (D-20)
     */
    write(turnData) {
        if (!turnData || !turnData.project || !turnData.turn_id) {
            throw new Error('project and turn_id are required to write to outbox');
        }

        const entryId = `outbox_${this.nextId++}_${Date.now()}`;
        const entry = {
            id: entryId,
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
            data: { ...turnData },
        };

        this.queue.push(entry);
        return {
            queued: true,
            id: entryId,
            turn_id: turnData.turn_id,
            queueLength: this.queue.length,
        };
    }

    /**
     * Peek pending entries up to limit
     */
    peek(limit = 50) {
        return this.queue.filter((e) => e.status === 'pending').slice(0, limit);
    }

    /**
     * Acknowledge successfully shipped entries
     */
    ack(entryIds = []) {
        const idSet = new Set(entryIds);
        this.queue = this.queue.filter((e) => !idSet.has(e.id));
        return {
            acked: entryIds.length,
            remaining: this.queue.length,
        };
    }

    /**
     * Current number of pending entries
     */
    size() {
        return this.queue.filter((e) => e.status === 'pending').length;
    }

    /**
     * Total queue length
     */
    get length() {
        return this.queue.length;
    }
}

/**
 * Ingest / Flush runner: drains entries from outbox and ingests into target database.
 *
 * @param {OutboxBuffer} outbox Local outbox buffer
 * @param {object} db Target database handle
 * @param {object} [options]
 * @param {number} [options.batchSize=50] Maximum items per batch
 * @param {boolean} [options.isRuntime=true]
 * @returns {object} Flush summary
 */
export async function flushOutbox(outbox, db, { batchSize = 50, isRuntime = true } = {}) {
    if (!outbox || typeof outbox.peek !== 'function') {
        throw new Error('Valid outbox buffer is required');
    }

    const batch = outbox.peek(batchSize);
    if (batch.length === 0) {
        return {
            shippedCount: 0,
            failedCount: 0,
            remaining: outbox.size(),
        };
    }

    const ackedIds = [];
    let failedCount = 0;
    let lastError = null;

    for (const item of batch) {
        try {
            // Ingest into evidence tables (idempotent: AC-EV-01-06)
            await recordTurn(db, item.data, { isRuntime });
            ackedIds.push(item.id);
        } catch (err) {
            // If DB is offline, connection fails, or unexpected error occurs:
            // Do NOT remove item from outbox. It will be retried on next flush.
            failedCount++;
            lastError = err;
            break; // Stop batch on connection/transient error to avoid cascading failures
        }
    }

    if (ackedIds.length > 0) {
        outbox.ack(ackedIds);
    }

    return {
        shippedCount: ackedIds.length,
        failedCount,
        remaining: outbox.size(),
        lastError: lastError ? lastError.message : null,
    };
}

/**
 * Ingest worker with periodic timer / background polling support.
 */
export class IngestWorker {
    constructor(outbox, db, { intervalMs = 1000, batchSize = 50 } = {}) {
        this.outbox = outbox;
        this.db = db;
        this.intervalMs = intervalMs;
        this.batchSize = batchSize;
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.timer = setInterval(() => {
            this.tick().catch(() => {});
        }, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async tick() {
        return await flushOutbox(this.outbox, this.db, { batchSize: this.batchSize, isRuntime: true });
    }
}
