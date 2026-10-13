import { describe, expect, it } from 'vitest';
import { MountLedger } from './mountLedger';

function fakeGraph(onDestroy?: () => void) {
    return {
        destroyed: false,
        destroy() {
            this.destroyed = true;
            onDestroy?.();
        },
    };
}

describe('MountLedger', () => {
    it('destroys a graph whose token was invalidated before it finished mounting', () => {
        const ledger = new MountLedger<ReturnType<typeof fakeGraph>>();

        // Run 1 starts and parks on `await import('@antv/g6')`.
        const token1 = ledger.begin();
        const graph1 = fakeGraph();

        // React 18 StrictMode's simulated unmount: cleanup invalidates run 1.
        ledger.invalidate();

        // Run 2 starts.
        const token2 = ledger.begin();
        const graph2 = fakeGraph();

        // Run 1's import finally resolves and tries to publish.
        expect(ledger.keep(token1, graph1)).toBe(false);

        // Run 2 publishes normally.
        expect(ledger.keep(token2, graph2)).toBe(true);

        expect(ledger.size).toBe(1);
        expect(graph1.destroyed).toBe(true);
        expect(graph2.destroyed).toBe(false);
    });

    it('a plain mount → cleanup → mount cycle leaves exactly one live graph', () => {
        const ledger = new MountLedger<ReturnType<typeof fakeGraph>>();

        const a = ledger.begin();
        const graphA = fakeGraph();
        expect(ledger.keep(a, graphA)).toBe(true);

        ledger.invalidate(); // cleanup
        expect(graphA.destroyed).toBe(true);
        expect(ledger.size).toBe(0);

        const b = ledger.begin();
        const graphB = fakeGraph();
        expect(ledger.keep(b, graphB)).toBe(true);
        expect(ledger.size).toBe(1);
        expect(graphB.destroyed).toBe(false);
    });

    it('does not publish any current-run value twice', () => {
        const ledger = new MountLedger<ReturnType<typeof fakeGraph>>();
        const token = ledger.begin();
        const graphs = [fakeGraph(), fakeGraph(), fakeGraph(), fakeGraph()];
        for (const g of graphs) expect(ledger.keep(token, g)).toBe(true);
        // Four panels, four graphs — never eight.
        expect(ledger.size).toBe(4);
        expect(graphs.filter((g) => g.destroyed)).toHaveLength(0);
    });

    it('invalidating twice is safe and destroys nothing extra', () => {
        const ledger = new MountLedger<ReturnType<typeof fakeGraph>>();
        const token = ledger.begin();
        const g = fakeGraph();
        ledger.keep(token, g);
        ledger.invalidate();
        ledger.invalidate();
        expect(g.destroyed).toBe(true);
        expect(ledger.size).toBe(0);
    });

    it('survives a graph whose destroy throws', () => {
        const ledger = new MountLedger<{ destroy: () => void }>();
        const token = ledger.begin();
        ledger.keep(token, {
            destroy() {
                throw new Error('canvas already gone');
            },
        });
        expect(() => ledger.invalidate()).not.toThrow();
        expect(ledger.size).toBe(0);
    });
});
