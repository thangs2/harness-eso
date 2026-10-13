import { describe, expect, it } from 'vitest';
import { blueprintBoard, comboCanvasHeight, rankCombo } from './blueprintLayout';

const n = (...ids: string[]) => ids.map((id) => ({ id }));
const e = (source: string, target: string) => ({ source, target });

describe('rankCombo', () => {
    it('ranks a straight chain 0..n-1 top to bottom', () => {
        const { rank, depth, backEdges } = rankCombo(n('a', 'b', 'c'), [e('a', 'b'), e('b', 'c')]);
        expect(rank.get('a')).toBe(0);
        expect(rank.get('b')).toBe(1);
        expect(rank.get('c')).toBe(2);
        expect(depth).toBe(3);
        expect(backEdges.size).toBe(0);
    });

    it('takes the LONGEST path, not the shortest', () => {
        // a -> b -> c -> d and a -> d: d must sit below c, or the arrow a->d would point up.
        const { rank } = rankCombo(
            n('a', 'b', 'c', 'd'),
            [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('a', 'd')],
        );
        expect(rank.get('d')!).toBeGreaterThan(rank.get('c')!);
    });

    it('detects the edge that closes a cycle, as dagre reverses it', () => {
        // Feedback loop, e.g. Phase D -> Phase B in the real blueprint.
        const { backEdges, rank } = rankCombo(
            n('p', 'q', 'd'),
            [e('p', 'q'), e('q', 'd'), e('d', 'p')],
        );
        expect(backEdges.size).toBe(1);
        expect([...backEdges]).toEqual(['d->p']);
        // The reversal keeps p above d, so the rank order stays resolvable.
        expect(rank.get('p')!).toBeLessThan(rank.get('d')!);
    });

    it('puts siblings on the same rank so a fan-out stays level', () => {
        const { rank, depth } = rankCombo(
            n('a', 'b', 'c', 'd'),
            [e('a', 'b'), e('a', 'c'), e('a', 'd')],
        );
        expect(rank.get('b')).toBe(1);
        expect(rank.get('c')).toBe(1);
        expect(rank.get('d')).toBe(1);
        expect(depth).toBe(2);
    });

    it('ignores an edge whose endpoint is not in the combo', () => {
        const { depth } = rankCombo(n('a', 'b'), [e('a', 'b'), e('b', 'outside')]);
        expect(depth).toBe(2);
    });

    it('returns depth 0 for an empty combo instead of throwing', () => {
        expect(rankCombo([], []).depth).toBe(0);
        expect(rankCombo(n('solo'), []).depth).toBe(1);
    });
});

describe('comboCanvasHeight', () => {
    it('grows with the number of ranks so fitView does not zoom the graph out', () => {
        const chain = (len: number) => {
            const ids = Array.from({ length: len }, (_, i) => `n${i}`);
            const edges = ids.slice(1).map((id, i) => e(ids[i], id));
            return { nodes: n(...ids), edges };
        };
        const short = comboCanvasHeight(chain(3).nodes, chain(3).edges);
        const tall = comboCanvasHeight(chain(10).nodes, chain(10).edges);
        expect(tall).toBeGreaterThan(short);
        // 10 ranks * 26 + 9 * 40 + 2 * 18 board pad + 2 * 16 canvas pad = 688
        expect(tall).toBe(688);
    });

    it('clamps to the provided bounds', () => {
        const chain = (len: number) => {
            const ids = Array.from({ length: len }, (_, i) => `n${i}`);
            const edges = ids.slice(1).map((id, i) => e(ids[i], id));
            return { nodes: n(...ids), edges };
        };
        expect(comboCanvasHeight(chain(2).nodes, chain(2).edges, { min: 300 })).toBe(300);
        expect(comboCanvasHeight(chain(40).nodes, chain(40).edges, { max: 640 })).toBe(640);
    });

    it('falls back to the minimum for an empty graph', () => {
        expect(comboCanvasHeight([], [], { min: 260 })).toBe(260);
    });
});

describe('blueprintBoard', () => {
    const labelled = (...ids: string[]) => ids.map((id) => ({ id, label: id }));

    it('stacks ranks top to bottom and never overlaps siblings', () => {
        const { nodes, width, height, depth } = blueprintBoard(
            labelled('a', 'b', 'c', 'd'),
            [e('a', 'b'), e('b', 'c'), e('b', 'd')],
        );
        expect(depth).toBe(3);
        const at = new Map(nodes.map((nd) => [nd.id, nd]));
        expect(at.get('a')!.y).toBeLessThan(at.get('b')!.y);
        expect(at.get('b')!.y).toBeLessThan(at.get('c')!.y);
        // c and d share a rank, so they sit side by side and the row fits the board.
        expect(at.get('c')!.y).toBe(at.get('d')!.y);
        expect(at.get('c')!.x).not.toBe(at.get('d')!.x);
        const right = Math.max(...nodes.map((nd) => nd.x + nd.w / 2));
        expect(right).toBeLessThanOrEqual(width);
        expect(height).toBeGreaterThan(0);
    });

    it('keeps the spine in one column so declaration order reads as the main flow', () => {
        // Different label lengths on purpose: the spine aligns on its LEFT edge, not its centre,
        // because nodes in a rank are laid out left to right from a shared origin.
        const { nodes } = blueprintBoard(
            [
                { id: 'start', label: 'start' },
                { id: 'child', label: 'child' },
                { id: 'grandchild', label: 'grandchild' },
                { id: 'branch', label: 'branch' },
            ],
            [e('start', 'child'), e('child', 'grandchild'), e('child', 'branch')],
        );
        const at = new Map(nodes.map((nd) => [nd.id, nd]));
        const left = (id: string) => at.get(id)!.x - at.get(id)!.w / 2;
        // Declared first, so `grandchild` is the spine and `branch` hangs off to its right.
        expect(left('grandchild')).toBe(left('child'));
        expect(left('branch')).toBeGreaterThan(left('grandchild'));
    });

    it('returns an empty board instead of throwing', () => {
        expect(blueprintBoard([], [])).toEqual({ nodes: [], width: 0, height: 0, depth: 0 });
    });

    /*
     * Pins the panel the operator actually reads. §1 contains two real feedback edges
     * (Phase D → Phase B retry, EvidenceBundle → agent loop); a layout engine that resolves them
     * by cutting the cheapest edge instead of the loop renders Phase D on top and Phase A near the
     * bottom. Importing the real blueprint instead of a fixture means this cannot silently drift
     * away from what the server sends.
     */
    it('renders §1 System context as Phase A → B → C → D, top to bottom', async () => {
        // The server package ships plain ESM with no type declarations, so the shape is asserted
        // on the cast instead of relying on inference.
        // @ts-expect-error -- .mjs entry point without a declaration file
        const mod = (await import('../../../../harness-observe-server/src/decision-design-view.mjs')) as {
            designBlueprint: () => {
                nodes: Array<{ id: string; data: { combo: string; label: string } }>;
                edges: Array<{ id: string; source: string; target: string }>;
            };
        };
        const blue = mod.designBlueprint();
        const own = blue.nodes.filter((nd) => nd.data.combo === 'c1');
        const ids = new Set(own.map((nd) => nd.id));
        const local = blue.edges.filter((ed) => ids.has(ed.source) && ids.has(ed.target));
        const { nodes, depth } = blueprintBoard(
            own.map((nd) => ({ id: nd.id, label: nd.data.label })),
            local,
        );

        const rank = new Map([...rankCombo(own, local).rank]);
        const y = new Map(nodes.map((nd) => [nd.id, nd.y]));
        for (const phase of ['R', 'P', 'PH_C', 'PH_D']) {
            expect(own.some((nd) => nd.id === phase)).toBe(true);
        }
        // Phase A above Phase B above Phase C above Phase D — the falldown the panel promises.
        expect(rank.get('R')!).toBeLessThan(rank.get('P')!);
        expect(rank.get('P')!).toBeLessThan(rank.get('PH_C')!);
        expect(rank.get('PH_C')!).toBeLessThan(rank.get('PH_D')!);
        expect(y.get('R')!).toBeLessThan(y.get('P')!);
        expect(y.get('P')!).toBeLessThan(y.get('PH_C')!);
        expect(y.get('PH_C')!).toBeLessThan(y.get('PH_D')!);

        // The entry point is the topmost node, and the observe plane is the exit.
        const top = [...y.entries()].sort((a, b) => a[1] - b[1])[0][0];
        expect(top).toBe('U');
        expect(rank.get('UI')!).toBe(depth - 1);

        // The retry edge is the one reversed; it must not be drawn as a downward step.
        expect(rank.get('PH_D')!).toBeGreaterThan(rank.get('P')!);
    });
});
