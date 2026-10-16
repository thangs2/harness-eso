/**
 * List-row token fallbacks: request columns → hook stop → emit_chars estimate (~÷4).
 */

export function detectIde(transcriptPath) {
    if (!transcriptPath || typeof transcriptPath !== 'string') return 'unknown';
    const lower = transcriptPath.toLowerCase();
    if (lower.includes('antigravity') || lower.includes('/brain/')) {
        return 'antigravity';
    }
    if (lower.includes('cursor') || lower.includes('agent-transcripts')) {
        return 'cursor';
    }
    return 'unknown';
}

export function enrichRequestListRow(row) {
    const emitChars = Number(row.emitCharsSum) || 0;
    let inputTokens = row.inputTokens ?? row.stopInputTokens ?? null;
    let outputTokens = row.outputTokens ?? row.stopOutputTokens ?? null;
    let tokensEstimated = false;
    if (outputTokens == null && emitChars > 0) {
        outputTokens = Math.round(emitChars / 4);
        tokensEstimated = true;
    }
    const ide = row.ide || detectIde(row.transcriptPath);
    return {
        id: row.id,
        generationId: row.generationId,
        conversationId: row.conversationId,
        boundaryIndex: row.boundaryIndex,
        userQuery: row.userQuery,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        status: row.status,
        stopStatus: row.stopStatus ?? null,
        decisionVerdict: row.decisionVerdict,
        callCount: row.callCount,
        toolCount: row.toolCount,
        inputTokens,
        outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        modelId: row.modelId,
        hasFailures: row.hasFailures,
        checksPass: row.checksPass,
        checksFail: row.checksFail,
        tokensEstimated,
        emitChars: emitChars > 0 ? emitChars : null,
        ide,
    };
}
