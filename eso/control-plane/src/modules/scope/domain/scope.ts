/**
 * @mu/eso-control-plane — Scope Guard & Refusal Engine (ESO-90 / US-AGENT-01 / Slice S1)
 *
 * Invariants & Acceptance Criteria:
 * - AC-AGENT-01-01: Target file outside allowed_files -> BLOCKED_SCOPE refusal; no partial disk changes; records refusal.
 * - AC-AGENT-01-02: Agent attempting to mark task 'Done' -> DONE_FORBIDDEN refusal; state unchanged.
 * - AC-AGENT-01-03: Work item outside scope -> OUT_OF_SCOPE refusal; does NOT reveal whether item exists.
 * - AC-AGENT-01-04: Target file inside allowed_files -> permitted; write succeeds.
 * - AC-AGENT-01-05 / ED1: allowed_files is empty -> EMPTY_SCOPE refusal; rejects all writes.
 * - AC-AGENT-01-06 / ED10: allowed_files points to deleted/non-existent directory -> DANGLING_SCOPE refusal.
 */

/**
 * Checks if target path matches a glob pattern.
 */
function matchGlob(path, pattern) {
    const normPath = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const normPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

    if (normPattern.endsWith('/**')) {
        const prefix = normPattern.slice(0, -3);
        return normPath === prefix || normPath.startsWith(prefix + '/');
    }

    if (normPattern.includes('*')) {
        const regexStr = '^' + normPattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$';
        return new RegExp(regexStr).test(normPath);
    }

    return normPath === normPattern;
}

/**
 * Evaluates whether a file write target is within allowed scope.
 *
 * @param {object} params
 * @param {Array<string>} params.allowedFiles List of allowed file patterns
 * @param {string} params.targetPath Target file path
 * @param {function} [params.dirExists] Optional callback (dirPath) => boolean
 * @returns {object} Verification verdict
 */
export function checkFileWriteScope({
    allowedFiles,
    targetPath,
    dirExists = null,
}: any = {}) {
    const normPath = (targetPath || '').replace(/\\/g, '/').trim();

    if (!normPath) {
        return {
            allowed: false,
            error: 'BLOCKED_SCOPE',
            targetPath: normPath,
            message: 'Target path cannot be empty.',
        };
    }

    // AC-AGENT-01-05: Empty scope
    if (!allowedFiles || !Array.isArray(allowedFiles) || allowedFiles.length === 0) {
        return {
            allowed: false,
            error: 'EMPTY_SCOPE',
            targetPath: normPath,
            message: 'allowed_files is empty. All file writes are forbidden.',
        };
    }

    // AC-AGENT-01-06: Dangling scope / deleted directory
    if (typeof dirExists === 'function') {
        const pathParts = normPath.split('/');
        pathParts.pop();
        const parentDir = pathParts.join('/');
        if (parentDir && !dirExists(parentDir)) {
            return {
                allowed: false,
                error: 'DANGLING_SCOPE',
                targetPath: normPath,
                message: `Target directory '${parentDir}' does not exist or has been deleted.`,
            };
        }
    }

    // AC-AGENT-01-04 & AC-AGENT-01-01: Check match against allowed_files
    const isMatched = allowedFiles.some((pattern) => matchGlob(normPath, pattern));

    if (!isMatched) {
        return {
            allowed: false,
            error: 'BLOCKED_SCOPE',
            targetPath: normPath,
            message: `File '${normPath}' is outside allowed_files scope: [${allowedFiles.join(', ')}]`,
        };
    }

    return {
        allowed: true,
        targetPath: normPath,
    };
}

/**
 * Executes a file write with strict scope enforcement and refusal logging (AC-AGENT-01-01, AC-AGENT-01-04).
 *
 * @param {object} params
 * @param {Array<string>} params.allowedFiles Scope
 * @param {string} params.targetPath File path
 * @param {string} params.content File content
 * @param {function} params.writeFileFn Write implementation: (path, content) => void
 * @param {function} [params.logRefusalFn] Refusal logger: (refusalRecord) => void
 * @param {function} [params.dirExists] Optional directory check
 * @returns {object} Execution summary
 */
export function executeFileWrite({
    allowedFiles,
    targetPath,
    content,
    writeFileFn,
    logRefusalFn = null,
    dirExists = null,
}: any = {}) {
    const verdict = checkFileWriteScope({ allowedFiles, targetPath, dirExists });

    if (!verdict.allowed) {
        const refusal = {
            error: verdict.error,
            targetPath: verdict.targetPath,
            reason: verdict.message,
            at: new Date().toISOString(),
        };

        if (typeof logRefusalFn === 'function') {
            logRefusalFn(refusal);
        }

        const err: any = new Error(`${verdict.error}: ${verdict.message}`);
        err.code = verdict.error;
        err.targetPath = verdict.targetPath;
        throw err;
    }

    if (typeof writeFileFn !== 'function') {
        throw new Error('writeFileFn is required to perform file write');
    }

    // Write file (no partial edits on failure)
    writeFileFn(verdict.targetPath, content);

    return {
        success: true,
        targetPath: verdict.targetPath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
}

/**
 * Transitions task status with role guard (AC-AGENT-01-02).
 * Agents are strictly forbidden from setting a task to 'Done' or 'Closed'.
 *
 * @param {object} params
 * @param {string} params.currentStatus Current status
 * @param {string} params.newStatus Target status
 * @param {string} params.actorRole Actor role ('agent' | 'human' | 'operator')
 * @param {function} [params.logRefusalFn] Optional logger
 * @returns {object} Result
 */
export function transitionTaskStatus({
    currentStatus,
    newStatus,
    actorRole = 'agent',
    logRefusalFn = null,
}: any = {}) {
    const normNew = (newStatus || '').toLowerCase().trim();

    if (actorRole !== 'human' && actorRole !== 'operator') {
        if (normNew === 'done' || normNew === 'closed') {
            const refusal = {
                error: 'DONE_FORBIDDEN',
                currentStatus,
                requestedStatus: newStatus,
                actorRole,
                reason: 'Agents are strictly forbidden from marking tasks as Done. Only human operator can sign Done.',
                at: new Date().toISOString(),
            };

            if (typeof logRefusalFn === 'function') {
                logRefusalFn(refusal);
            }

            const err: any = new Error(`DONE_FORBIDDEN: Agents are forbidden from transitioning to ${newStatus}. Only human operator can sign Done.`);
            err.code = 'DONE_FORBIDDEN';
            err.currentStatus = currentStatus;
            throw err;
        }
    }

    return {
        success: true,
        previousStatus: currentStatus,
        status: newStatus,
    };
}

/**
 * Queries judgement/details for a task with leak prevention (AC-AGENT-01-03).
 * Refusal message is strictly identical regardless of whether task exists or not.
 *
 * @param {object} params
 * @param {Array<string>} params.agentScope List of task IDs owned by agent
 * @param {string} params.taskId Queried task ID
 * @param {Map|Set|object} [params.taskStore] Backing store (optional)
 * @param {function} [params.logRefusalFn] Optional refusal logger
 * @returns {object} Judgement result
 */
export function queryTaskJudgement({
    agentScope = [],
    taskId,
    taskStore = null,
    logRefusalFn = null,
}: any = {}) {
    const isOwned = Array.isArray(agentScope) && agentScope.includes(taskId);

    if (!isOwned) {
        const refusal = {
            error: 'OUT_OF_SCOPE',
            reason: 'Requested item is outside declared scope',
            at: new Date().toISOString(),
        };

        if (typeof logRefusalFn === 'function') {
            logRefusalFn(refusal);
        }

        const err: any = new Error('OUT_OF_SCOPE: Requested item is outside declared scope');
        err.code = 'OUT_OF_SCOPE';
        throw err;
    }

    // Task is owned; fetch details from store if present
    let task = null;
    if (taskStore) {
        if (typeof taskStore.get === 'function') task = taskStore.get(taskId);
        else if (taskStore[taskId]) task = taskStore[taskId];
    }

    return {
        allowed: true,
        taskId,
        task: task || { id: taskId, status: 'IN_SCOPE' },
    };
}
