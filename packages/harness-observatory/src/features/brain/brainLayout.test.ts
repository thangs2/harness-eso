import { describe, expect, it } from 'vitest';
import type { BrainGraphDocument, BrainLayer, BrainNode } from '@/shared/api/types';
import { hitTest } from './brainHitTest';
import {
    BRAIN_NO_AREA,
    BRAIN_VIEWS,
    LAYER_ORDER,
    filterBrainGraph,
    hashString,
    layoutBrain,
    radiusForNode,
} from './brainLayout';
import { cameraForNode, fitCamera, projectPoint, zoomAt } from './brainProjection';

function node(id: string, kind: BrainNode['kind'], layer: BrainLayer, extra: Partial<BrainNode> = {}): BrainNode {
    return {
        id,
        kind,
        layer,
        label: id,
        area: null,
        path: null,
        pathHost: null,
        previewable: false,
        note: null,
        changed: null,
        degree: 1,
        weight: 1,
        ...extra,
    };
}

function fixture(): BrainGraphDocument {
    const nodes: BrainNode[] = [
        node('project:p', 'root', 'core', { label: 'harness-eso', area: null }),
        node('area:packages', 'area', 'memory', { area: 'packages', degree: 6 }),
        node('area:documents', 'area', 'memory', { area: 'documents', degree: 4 }),
        node('skill:core.harness-product', 'skill', 'skills', { degree: 2 }),
        node('tool:read', 'tool', 'skills', { degree: 5 }),
        node('app:cursor', 'app', 'apps', { degree: 3 }),
    ];
    for (let i = 0; i < 12; i += 1) {
        nodes.push(
            node(`note:/w/packages/f${i}.mjs`, 'note', 'memory', {
                area: i % 2 === 0 ? 'packages' : 'documents',
                path: `/w/packages/f${i}.mjs`,
                changed: `2026-10-0${(i % 9) + 1}T10:00:00Z`,
                degree: i + 1,
            }),
        );
        nodes.push(
            node(`run:c:${i}`, 'run', 'runs', {
                changed: i === 0 ? null : `2026-10-0${(i % 9) + 1}T11:00:00Z`,
                degree: i % 4,
            }),
        );
    }
    const links = [];
    for (let i = 0; i < 12; i += 1) {
        links.push({ s: 'project:p', t: 'area:packages' });
        links.push({ s: 'area:' + (i % 2 === 0 ? 'packages' : 'documents'), t: `note:/w/packages/f${i}.mjs` });
        links.push({ s: `run:c:${i}`, t: `note:/w/packages/f${i}.mjs` });
        if (i % 2 === 0) links.push({ s: `run:c:${i}`, t: 'tool:read' });
    }
    return {
        version: 1,
        nodes,
        links,
        meta: {
            builtAt: '2026-10-22T00:00:00Z',
            project: { id: 'p', label: 'harness-eso', rootPath: '/w' },
            sources: [],
            omitted: [],
            truncated: [],
            limits: {},
        },
    };
}

const VIEW_IDS = BRAIN_VIEWS.map((v) => v.id);

describe('layoutBrain', () => {
    const doc = fixture();

    it('places every node in every view and reports real bounds', () => {
        for (const view of VIEW_IDS) {
            const layout = layoutBrain(view, doc);
            expect(layout.positions.size, view).toBe(doc.nodes.length);
            for (const n of doc.nodes) expect(layout.positions.has(n.id), `${view}:${n.id}`).toBe(true);
            const { bounds } = layout;
            expect(bounds.maxX - bounds.minX, `${view} width`).toBeGreaterThan(0);
            expect(bounds.maxY - bounds.minY, `${view} height`).toBeGreaterThan(0);
            for (const p of layout.positions.values()) {
                expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
            }
        }
    });

    it('is deterministic — a reload draws the same picture', () => {
        for (const view of VIEW_IDS) {
            const a = layoutBrain(view, doc).positions;
            const b = layoutBrain(view, doc).positions;
            for (const [id, p] of a) {
                expect(b.get(id), `${view}:${id}`).toEqual(p);
            }
        }
    });

    it('keeps the same node set when switching views', () => {
        const sets = VIEW_IDS.map((v) => [...layoutBrain(v, doc).positions.keys()].sort().join('|'));
        expect(new Set(sets).size).toBe(1);
    });

    it('rings puts each layer further out, the root in the centre', () => {
        const { positions } = layoutBrain('rings', doc);
        const root = positions.get('project:p')!;
        expect(root).toEqual({ x: 0, y: 0, z: 0 });
        const radiusOf = (layer: BrainLayer) =>
            Math.max(
                ...doc.nodes
                    .filter((n) => n.layer === layer && n.kind !== 'root')
                    .map((n) => Math.hypot(positions.get(n.id)!.x, positions.get(n.id)!.y)),
            );
        const radii = LAYER_ORDER.filter((l) => l !== 'core').map(radiusOf);
        for (let i = 1; i < radii.length; i += 1) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    });

    it('timeline gives each layer its own lane and parks undated nodes apart', () => {
        const { positions } = layoutBrain('timeline', doc);
        const laneOf = (layer: BrainLayer) => {
            const members = doc.nodes.filter((n) => n.layer === layer);
            const pick = members.find((n) => n.changed != null) ?? members[0];
            return positions.get(pick.id)!.y;
        };
        const lanes = ['memory', 'skills', 'runs', 'apps'].map((l) => laneOf(l as BrainLayer));
        expect(new Set(lanes).size).toBe(4);
        // An undated node stays in its own lane but is pinned to the left edge, never folded into
        // the oldest bucket — the renderer marks it hollow.
        const undated = doc.nodes.find((n) => n.id === 'run:c:0')!;
        const datedRun = doc.nodes.find((n) => n.layer === 'runs' && n.changed != null)!;
        expect(positions.get(undated.id)!.y).toBe(positions.get(datedRun.id)!.y);
        expect(positions.get(undated.id)!.x).toBe(-(1600 / 2 - 80));
    });

    it('orbit adds depth to everything except the root', () => {
        const { positions } = layoutBrain('orbit', doc);
        expect(positions.get('project:p')!.z).toBe(0);
        const depths = [...positions.values()].filter((p) => p.z !== 0);
        expect(depths.length).toBeGreaterThan(doc.nodes.length / 2);
    });

    it('links stays finite and inside the world box', () => {
        const { positions } = layoutBrain('links', doc);
        for (const p of positions.values()) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1600);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1000);
        }
    });

    it('an empty graph is an empty layout, not a crash', () => {
        for (const view of VIEW_IDS) {
            const layout = layoutBrain(view, null);
            expect(layout.positions.size).toBe(0);
            expect(layout.bounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
        }
    });
});

describe('radiusForNode', () => {
    it('grows with degree and is capped', () => {
        const small = radiusForNode(node('a', 'note', 'memory', { degree: 0 }));
        const mid = radiusForNode(node('b', 'note', 'memory', { degree: 8 }));
        const huge = radiusForNode(node('c', 'note', 'memory', { degree: 10000 }));
        expect(mid).toBeGreaterThan(small);
        expect(huge).toBeLessThanOrEqual(15);
    });
});

describe('projection', () => {
    const viewport = { width: 800, height: 600 };

    it('is an identity transform at zero depth, zero rotation and zoom 1', () => {
        const projected = projectPoint({ x: 100, y: -50, z: 0 }, { x: 0, y: 0, zoom: 1 }, viewport);
        expect(projected.x).toBeCloseTo(400 + 100);
        expect(projected.y).toBeCloseTo(300 - 50);
        expect(projected.scale).toBeCloseTo(1);
    });

    it('rotation swings x and z into each other, and y is untouched', () => {
        const flat = { x: 100, y: 40, z: 0 };
        const depth = { x: 100, y: 40, z: 200 };
        // A quarter turn maps (x, z) -> (z, -x): the flat point loses its x, the deep point gains one.
        const flat90 = projectPoint(flat, { x: 0, y: 0, zoom: 1 }, viewport, Math.PI / 2);
        const depth90 = projectPoint(depth, { x: 0, y: 0, zoom: 1 }, viewport, Math.PI / 2);
        expect(flat90.x).toBeCloseTo(400);
        expect(depth90.x).toBeGreaterThan(flat90.x);
        expect(flat90.y).toBeGreaterThan(300);
        // Perspective: a nearer node (negative z) renders larger than a farther one.
        const near = projectPoint({ x: 0, y: 0, z: -400 }, { x: 0, y: 0, zoom: 1 }, viewport);
        const far = projectPoint({ x: 0, y: 0, z: 400 }, { x: 0, y: 0, zoom: 1 }, viewport);
        expect(near.scale).toBeGreaterThan(far.scale);
    });

    it('fitCamera frames the bounds', () => {
        const camera = fitCamera({ minX: -500, maxX: 500, minY: -250, maxY: 250, minZ: 0, maxZ: 0 }, viewport);
        expect(camera.x).toBe(0);
        expect(camera.y).toBe(0);
        expect(camera.zoom).toBeGreaterThan(0.5);
        expect(camera.zoom).toBeLessThanOrEqual(5);
    });

    it('zoomAt keeps the world point under the cursor', () => {
        const camera = { x: 0, y: 0, zoom: 1 };
        const anchor = { x: 600, y: 400 };
        const before = { x: (anchor.x - 400) / camera.zoom + camera.x, y: (anchor.y - 300) / camera.zoom + camera.y };
        const zoomed = zoomAt(camera, viewport, anchor, 2);
        const after = { x: (anchor.x - 400) / zoomed.zoom + zoomed.x, y: (anchor.y - 300) / zoomed.zoom + zoomed.y };
        expect(after.x).toBeCloseTo(before.x);
        expect(after.y).toBeCloseTo(before.y);
    });

    it('cameraForNode centres on the node and zooms past fit', () => {
        const camera = cameraForNode({ x: 300, y: 120, z: 0 }, viewport);
        expect(camera).toMatchObject({ x: 300, y: 120 });
        expect(camera.zoom).toBeGreaterThanOrEqual(1.6);
    });
});

describe('filterBrainGraph', () => {
    const doc = fixture();

    it('isolates an area but keeps the root and drops dangling links', () => {
        const filtered = filterBrainGraph(doc, { area: 'packages' })!;
        expect(filtered.nodes.some((n) => n.kind === 'root')).toBe(true);
        expect(filtered.nodes.every((n) => n.kind === 'root' || n.area === 'packages')).toBe(true);
        const ids = new Set(filtered.nodes.map((n) => n.id));
        for (const link of filtered.links) {
            expect(ids.has(link.s) && ids.has(link.t)).toBe(true);
        }
        expect(filtered.links.length).toBeGreaterThan(0);
    });

    it('the "no area" sentinel really matches nodes without an area', () => {
        const filtered = filterBrainGraph(doc, { area: BRAIN_NO_AREA })!;
        const kept = filtered.nodes.filter((n) => n.kind !== 'root');
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.every((n) => n.area === null)).toBe(true);
        expect(kept.some((n) => n.kind === 'run')).toBe(true);
        expect(kept.some((n) => n.kind === 'skill')).toBe(true);
    });

    it('filters by kind and returns the same document when nothing is filtered', () => {
        const onlyRuns = filterBrainGraph(doc, { kind: 'run' })!;
        expect(onlyRuns.nodes.filter((n) => n.kind !== 'root').every((n) => n.kind === 'run')).toBe(true);
        expect(filterBrainGraph(doc, {})).toBe(doc);
        expect(filterBrainGraph(null, { kind: 'run' })).toBeNull();
    });
});

describe('hitTest', () => {
    const viewport = { width: 800, height: 600 };

    it('picks the node that was painted under the cursor, and nothing off-node', () => {
        const doc = fixture();
        const layout = layoutBrain('areas', doc);
        const camera = fitCamera(layout.bounds, viewport);
        const projected = new Map(
            [...layout.positions.entries()].map(([id, point]) => [id, projectPoint(point, camera, viewport)]),
        );

        const target = doc.nodes.find((n) => n.kind === 'root')!;
        const screen = projected.get(target.id)!;
        expect(hitTest(doc.nodes, projected, { x: screen.x, y: screen.y })?.id).toBe(target.id);
        expect(hitTest(doc.nodes, projected, { x: -5000, y: -5000 })).toBeNull();
    });
});

describe('palette', () => {
    it('takes area colours from the app palette, never from ad-hoc hexes', async () => {
        const { areaColor } = await import('./brainStyle');
        const { AREA_PALETTE } = await import('./brainTokens');
        expect(areaColor('packages', 'memory')).toBe(areaColor('packages', 'memory'));
        expect(AREA_PALETTE).toContain(areaColor('packages', 'memory'));
        expect(AREA_PALETTE).toContain(areaColor(null, 'runs'));
        expect(areaColor('packages', 'memory')).not.toBe(areaColor('documents', 'memory'));
    });
});

describe('hashString', () => {
    it('is stable and spread out', () => {
        expect(hashString('note:/a/b.mjs')).toBe(hashString('note:/a/b.mjs'));
        const values = new Set(['a', 'b', 'c', 'd', 'e'].map((x) => hashString(x)));
        expect(values.size).toBe(5);
    });
});
