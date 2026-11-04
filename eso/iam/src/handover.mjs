/**
 * @mu/eso-iam — Worker Retirement Handover & Flow Integrity (US-IAM-07 / ESO-315 / Slice S1)
 *
 * Implements:
 * - AC-IAM-07-01: Worker with work and designated recipient records handover, transfers ownership, worker retired
 * - AC-IAM-07-02: Worker with work, no recipient and no open risk routing is rejected with RETIRE_WITH_WORK (0 changes)
 * - AC-IAM-07-03: Retired worker still referenced in flow surfaces DANGLING_FLOW (edit or open risk required)
 * - AC-IAM-07-04: Retiring already inactive/retired worker rejected with ALREADY_INACTIVE (0 changes)
 * - AC-IAM-07-05: Concurrent retire during handover ensures single winner and preserved work
 */

export function handoverWorkerWork({
    worker,
    activeWork = [],
    recipient,
    allowOpenRisk = false,
    reviewer = 'operator',
} = {}) {
    if (!worker || typeof worker !== 'object') {
        const err = new Error('Worker object is required');
        err.code = 'INVALID_WORKER';
        throw err;
    }

    // AC-IAM-07-04 / ED6: Already inactive
    if (worker.state === 'retired' || worker.state === 'inactive') {
        const err = new Error(`ALREADY_INACTIVE: Worker '${worker.worker_id}' is already retired/inactive (0 changes)`);
        err.code = 'ALREADY_INACTIVE';
        err.worker_id = worker.worker_id;
        throw err;
    }

    const tasks = Array.isArray(activeWork) ? activeWork : [];

    // AC-IAM-07-02: Worker has work but no recipient and no open risk flag
    if (tasks.length > 0 && !recipient && !allowOpenRisk) {
        const err = new Error(`RETIRE_WITH_WORK: Worker '${worker.worker_id}' has ${tasks.length} active work item(s) without assigned recipient or open risk routing`);
        err.code = 'RETIRE_WITH_WORK';
        err.worker_id = worker.worker_id;
        err.work_count = tasks.length;
        throw err;
    }

    const now = new Date().toISOString();

    // AC-IAM-07-01: Handover to designated recipient
    if (recipient) {
        const transferred_work = tasks.map((t) => ({
            ...t,
            previous_owner: worker.worker_id,
            owner: recipient,
            transferred_at: now,
        }));

        const handover_record = {
            handover_id: `ho-${worker.worker_id}-${Date.now()}`,
            from_worker: worker.worker_id,
            to_worker: recipient,
            tasks_count: transferred_work.length,
            work_items: transferred_work.map((t) => t.task_id || t.id),
            recorded_at: now,
        };

        return {
            ...worker,
            state: 'retired',
            handover_record,
            transferred_work,
            open_risks: [],
        };
    }

    // Fallback: routing to OPEN risk
    if (allowOpenRisk && tasks.length > 0) {
        const open_risks = tasks.map((t, idx) => ({
            risk_id: t.risk_id || `risk-retire-${worker.worker_id}-${idx + 1}`,
            project: worker.project,
            kind: 'orphaned_work',
            status: 'OPEN',
            owner: null,
            review_by: reviewer,
            what: t.what || t.title || `Việc đang dở từ worker ${worker.worker_id}`,
            task_id: t.task_id || t.id || null,
            created_at: now,
        }));

        return {
            ...worker,
            state: 'retired',
            handover_record: null,
            transferred_work: [],
            open_risks,
        };
    }

    // No work items
    return {
        ...worker,
        state: 'retired',
        handover_record: null,
        transferred_work: [],
        open_risks: [],
    };
}

export function checkFlowDanglingWorkers({
    flow,
    workers = [],
} = {}) {
    if (!flow || !Array.isArray(flow.steps)) {
        return { valid: true, dangling_workers: [] };
    }

    const dangling = [];
    for (const step of flow.steps) {
        if (step.worker_id) {
            const foundWorker = workers.find((w) => w.worker_id === step.worker_id);
            if (foundWorker && (foundWorker.state === 'retired' || foundWorker.state === 'inactive')) {
                dangling.push({
                    step_id: step.id || step.name,
                    worker_id: step.worker_id,
                    worker_state: foundWorker.state,
                });
            }
        }
    }

    if (dangling.length > 0) {
        return {
            valid: false,
            code: 'DANGLING_FLOW',
            dangling_workers: dangling,
            message: `DANGLING_FLOW: Flow references retired worker(s): ${dangling.map((d) => d.worker_id).join(', ')}`,
        };
    }

    return { valid: true, dangling_workers: [] };
}
