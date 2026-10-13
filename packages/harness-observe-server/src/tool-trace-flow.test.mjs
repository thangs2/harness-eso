import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolTraceFlowGraph } from './tool-trace-flow.mjs';

describe('buildToolTraceFlowGraph', () => {
    it('chains tools from llmCalls', () => {
        const g = buildToolTraceFlowGraph({
            userQuery: 'test',
            llmCalls: [
                { toolNames: 'Read,Shell', kind: 'batched' },
                { toolNames: '', kind: 'answer' },
            ],
        });
        assert.ok(g.nodes.length >= 4);
        assert.ok(g.edges.some((e) => e.source === 'tool-0' && e.target === 'tool-1'));
    });
});
