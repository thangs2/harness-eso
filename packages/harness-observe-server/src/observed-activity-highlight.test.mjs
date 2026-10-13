import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesignViewGraph } from './decision-design-view.mjs';
import { computeObservedActivityHighlight } from './observed-activity-highlight.mjs';

test('computeObservedActivityHighlight lights ingest spine and adapters', () => {
    const h = computeObservedActivityHighlight({
        tools: [{ tool: 'codegraph_explore' }, { tool: 'Read' }],
        events: [{ tool: 'Grep', path: '.cursor/rules/core.harness.mdc' }],
    });
    assert.ok(h.nodes.has('UI'));
    assert.ok(h.nodes.has('CG'));
    assert.ok(h.nodes.has('L0'));
});

test('buildDesignViewGraph uses observed fallback without ledger', () => {
    const fallback = computeObservedActivityHighlight({
        tools: [{ tool: 'Read' }],
    });
    const g = buildDesignViewGraph([], {}, fallback);
    const active = g.nodes.filter((n) => n.data.active);
    assert.ok(active.length >= 4);
});
