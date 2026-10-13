import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromaxFlowGraph } from './flow-graph-build.mjs';

describe('buildPromaxFlowGraph', () => {
    it('returns null when no rules or postToolUse events', () => {
        assert.equal(buildPromaxFlowGraph({ userQuery: 'hi' }), null);
    });

    it('builds rule combos and stage steps from events', () => {
        const g = buildPromaxFlowGraph({
            userQuery: 'test',
            attached: [{ type: 'rule', filePath: '/proj/.cursor/rules/core.foo.mdc' }],
            rootPath: '/proj',
            events: [
                {
                    eventType: 'postToolUse',
                    tool: 'Read',
                    path: '/proj/src/a.ts',
                },
            ],
        });
        assert.ok(g);
        assert.ok(g.nodes.some((n) => n.data?.kind === 'rule'));
        assert.ok(g.nodes.some((n) => n.data?.kind === 'step'));
        assert.ok(g.edges.length >= 2);
    });
});
