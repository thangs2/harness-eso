import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDesignViewGraph,
    computeHighlightForRow,
    designBlueprint,
} from './decision-design-view.mjs';

test('designBlueprint has unique node ids and four taxonomy combos', () => {
    const { combos, nodes, edges } = designBlueprint();
    assert.equal(combos.length, 4);
    assert.match(combos[0].data.label, /§1 System context/);
    assert.match(combos[1].data.label, /§2 Layer stack/);
    const ids = nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate node id in blueprint');
    assert.ok(edges.length > 40);
    assert.ok(nodes.some((n) => n.id === 'R' && n.data.label.includes('Phase A')));
    assert.ok(nodes.some((n) => n.id === 'L0'));
    assert.ok(nodes.some((n) => n.id === 'POL_JEV'));
});

test('computeHighlightForRow only references blueprint nodes', () => {
    const { nodes } = designBlueprint();
    const valid = new Set(nodes.map((n) => n.id));
    const row = {
        event_type: 'turn_start',
        jev_mode: 'shadow',
        enforced_verdict: 'route_l0',
        resolver_winner: 'l0_resolver',
    };
    const h = computeHighlightForRow(row);
    for (const id of h.nodes) {
        assert.ok(valid.has(id), `unknown highlight node: ${id}`);
    }
});

test('buildDesignViewGraph marks active nodes from ledger', () => {
    const g = buildDesignViewGraph([
        {
            event_type: 'turn_start',
            jev_mode: 'off',
            enforced_verdict: 'route_l0',
            resolver_winner: 'l0_resolver',
        },
    ]);
    assert.ok(g.legend.includes('19'));
    const active = g.nodes.filter((n) => n.data.active);
    assert.ok(active.length >= 5);
    assert.ok(active.some((n) => n.id === 'U' || n.id === 'ENTRY'));
});
