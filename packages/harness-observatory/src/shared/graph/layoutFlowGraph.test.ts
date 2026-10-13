import { describe, expect, it } from 'vitest';
import { layoutFlowGraph } from './layoutFlowGraph';

describe('layoutFlowGraph', () => {
    it('lays out blueprint combos in vertical bands', () => {
        const laid = layoutFlowGraph({
            combos: [
                { id: 'c1', data: { label: '§1' } },
                { id: 'c2', data: { label: '§2' } },
            ],
            nodes: [
                { id: 'a', combo: 'c1', data: { label: 'A', kind: 'blueprint' } },
                { id: 'b', combo: 'c1', data: { label: 'B', kind: 'blueprint' } },
                { id: 'x', combo: 'c2', data: { label: 'X', kind: 'blueprint' } },
            ],
            edges: [
                { id: 'e1', source: 'a', target: 'b' },
            ],
        });
        expect(laid).not.toBeNull();
        expect(laid!.comboBands?.length).toBe(2);
        expect(laid!.nodes.length).toBe(3);
        expect(laid!.height).toBeGreaterThan(200);
    });

    it('completes layout when combo subgraph has a cycle (blueprint feedback edges)', () => {
        const t0 = Date.now();
        const laid = layoutFlowGraph({
            combos: [{ id: 'c1', data: { label: 'cycle' } }],
            nodes: [
                { id: 'p', combo: 'c1', data: { label: 'P', kind: 'blueprint' } },
                { id: 'c', combo: 'c1', data: { label: 'C', kind: 'blueprint' } },
                { id: 'd', combo: 'c1', data: { label: 'D', kind: 'blueprint' } },
            ],
            edges: [
                { id: 'p-c', source: 'p', target: 'c' },
                { id: 'c-d', source: 'c', target: 'd' },
                { id: 'd-p', source: 'd', target: 'p' },
            ],
        });
        expect(laid).not.toBeNull();
        expect(laid!.nodes.length).toBe(3);
        expect(Date.now() - t0).toBeLessThan(500);
    });
});
