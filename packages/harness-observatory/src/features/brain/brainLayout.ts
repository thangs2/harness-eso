import type { BrainGraphDocument, BrainKind, BrainLayer, BrainNode } from '@/shared/api/types';
import { BRAIN_TUNING } from './brainTuning';

/**
 * The six views are pure layout functions over the same node set. Nothing here touches the DOM
 * or the clock (except `timeline`, which reads the timestamps already in the data), so every
 * view is testable in node — the canvas renderer is the only untested part of the feature.
 *
 * `orbit` reuses the `areas` layout and adds depth; the renderer rotates that depth around Y.
 * Determinism matters: the same graph must produce the same picture on every reload, otherwise
 * the operator cannot recognise their own workspace.
 */
export type BrainView = 'rings' | 'circle' | 'areas' | 'links' | 'timeline' | 'orbit';

export const BRAIN_VIEWS: { id: BrainView; label: string; hint: string }[] = [
    { id: 'rings', label: 'Rings', hint: 'concentric rings by layer, the root in the centre' },
    { id: 'circle', label: 'Circle', hint: 'every node on one ring, links across the middle' },
    { id: 'areas', label: 'Areas', hint: 'one cluster per area, the root in the middle' },
    { id: 'links', label: 'Links', hint: 'deterministic force pass — who shares files with whom' },
    { id: 'timeline', label: 'Timeline', hint: 'runs and files by last change, one lane per layer' },
    { id: 'orbit', label: '3D orbit', hint: 'a slow 2.5D projection that rotates on its own' },
];

export const LAYER_ORDER: BrainLayer[] = ['core', 'memory', 'skills', 'runs', 'apps'];

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface BrainBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
}

export interface BrainLayout {
    view: BrainView;
    positions: Map<string, Vec3>;
    bounds: BrainBounds;
}

const TAU = Math.PI * 2;

/** Stable 32-bit string hash — node placement must never depend on iteration order luck. */
export function hashString(value: string): number {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function hashUnit(value: string): number {
    return (hashString(value) % 100000) / 100000;
}

function layerIndex(layer: BrainLayer): number {
    const idx = LAYER_ORDER.indexOf(layer);
    return idx === -1 ? LAYER_ORDER.length : idx;
}

function groupKey(node: BrainNode): string {
    return node.area ?? node.layer;
}

function byAreaThenId(a: BrainNode, b: BrainNode): number {
    const ka = groupKey(a);
    const kb = groupKey(b);
    if (ka !== kb) return ka.localeCompare(kb);
    return a.id.localeCompare(b.id);
}

function emptyBounds(): BrainBounds {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
}

function boundsOf(positions: Map<string, Vec3>): BrainBounds {
    const b = emptyBounds();
    let first = true;
    for (const p of positions.values()) {
        if (first) {
            b.minX = b.maxX = p.x;
            b.minY = b.maxY = p.y;
            b.minZ = b.maxZ = p.z;
            first = false;
            continue;
        }
        if (p.x < b.minX) b.minX = p.x;
        if (p.x > b.maxX) b.maxX = p.x;
        if (p.y < b.minY) b.minY = p.y;
        if (p.y > b.maxY) b.maxY = p.y;
        if (p.z < b.minZ) b.minZ = p.z;
        if (p.z > b.maxZ) b.maxZ = p.z;
    }
    return first ? emptyBounds() : b;
}

/** rings — root in the centre, one ring per layer, clustered by area inside the ring. */
function layoutRings(nodes: BrainNode[]): Map<string, Vec3> {
    const positions = new Map<string, Vec3>();
    const byLayer = new Map<number, BrainNode[]>();
    for (const node of nodes) {
        const idx = layerIndex(node.layer);
        const bucket = byLayer.get(idx) ?? [];
        bucket.push(node);
        byLayer.set(idx, bucket);
    }
    for (const [idx, bucket] of byLayer) {
        bucket.sort(byAreaThenId);
        const radius = idx === 0 ? 0 : BRAIN_TUNING.ringStart + (idx - 1) * BRAIN_TUNING.ringGap;
        const count = bucket.length;
        bucket.forEach((node, i) => {
            if (radius === 0) {
                positions.set(node.id, { x: 0, y: 0, z: 0 });
                return;
            }
            const angle = (i / count) * TAU + idx * 0.618;
            positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 });
        });
    }
    return positions;
}

/** circle — every node on one ring, ordered by area so neighbours stay together. */
function layoutCircle(nodes: BrainNode[]): Map<string, Vec3> {
    const positions = new Map<string, Vec3>();
    const sorted = [...nodes].sort(byAreaThenId);
    const radius = BRAIN_TUNING.circleRadius;
    const count = sorted.length || 1;
    sorted.forEach((node, i) => {
        const angle = (i / count) * TAU;
        positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 });
    });
    return positions;
}

/** areas — one cluster per area on a big circle, members on a golden-angle spiral. */
function layoutAreas(nodes: BrainNode[]): Map<string, Vec3> {
    const positions = new Map<string, Vec3>();
    const groups = new Map<string, BrainNode[]>();
    for (const node of nodes) {
        const key = groupKey(node);
        const bucket = groups.get(key) ?? [];
        bucket.push(node);
        groups.set(key, bucket);
    }
    const keys = [...groups.keys()].sort();
    const root = nodes.find((n) => n.kind === 'root');
    if (root) positions.set(root.id, { x: 0, y: 0, z: 0 });

    keys.forEach((key, gi) => {
        const bucket = (groups.get(key) ?? []).filter((n) => n.id !== root?.id).sort((a, b) => a.id.localeCompare(b.id));
        if (!bucket.length) return;
        const angle = (gi / keys.length) * TAU;
        const cx = Math.cos(angle) * BRAIN_TUNING.areaRingRadius;
        const cy = Math.sin(angle) * BRAIN_TUNING.areaRingRadius;
        const spin = hashUnit(key) * TAU;
        bucket.forEach((node, i) => {
            if (i === 0) {
                positions.set(node.id, { x: cx, y: cy, z: 0 });
                return;
            }
            const radius = BRAIN_TUNING.areaClusterRadius * Math.sqrt(i / bucket.length);
            const theta = i * BRAIN_TUNING.goldenAngle + spin;
            positions.set(node.id, { x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius, z: 0 });
        });
    });
    return positions;
}

interface ForceNode {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
}

/**
 * Deterministic force pass. Seeded from the areas layout (no Math.random anywhere), so the same
 * graph settles into the same shape on every run. Repulsion is bucketed on a uniform grid: a node
 * only compares against its own cell and the 8 around it, which keeps 2k nodes at ~220 passes
 * around a second instead of minutes.
 */
export function layoutForce(
    nodes: BrainNode[],
    links: { s: string; t: string }[],
    seed: Map<string, Vec3>,
): Map<string, Vec3> {
    const t = BRAIN_TUNING;
    const list: ForceNode[] = nodes.map((node) => {
        const p = seed.get(node.id) ?? { x: 0, y: 0, z: 0 };
        return { id: node.id, x: p.x, y: p.y, vx: 0, vy: 0 };
    });
    const index = new Map(list.map((n, i) => [n.id, i]));
    const adjacency = links
        .map((l) => [index.get(l.s), index.get(l.t)] as const)
        .filter((pair): pair is readonly [number, number] => pair[0] != null && pair[1] != null);

    const n = list.length;
    if (!n) return new Map();
    const cell = Math.max(24, t.linkGridFactor * Math.sqrt((t.worldWidth * t.worldHeight) / Math.max(1, n)));

    for (let pass = 0; pass < t.linkIterations; pass += 1) {
        const buckets = new Map<string, number[]>();
        for (let i = 0; i < n; i += 1) {
            const key = `${Math.floor(list[i].x / cell)}:${Math.floor(list[i].y / cell)}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(i);
            else buckets.set(key, [i]);
        }

        for (let i = 0; i < n; i += 1) {
            const a = list[i];
            const gx = Math.floor(a.x / cell);
            const gy = Math.floor(a.y / cell);
            let fx = 0;
            let fy = 0;
            for (let ox = -1; ox <= 1; ox += 1) {
                for (let oy = -1; oy <= 1; oy += 1) {
                    const bucket = buckets.get(`${gx + ox}:${gy + oy}`);
                    if (!bucket) continue;
                    for (const j of bucket) {
                        if (i === j) continue;
                        const b = list[j];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        let dist2 = dx * dx + dy * dy;
                        if (dist2 < 1e-4) {
                            // Deterministic de-overlap for coincident nodes (same id pair, same order).
                            dx = (hashUnit(a.id) - 0.5) || 0.5;
                            dy = (hashUnit(b.id) - 0.5) || 0.5;
                            dist2 = dx * dx + dy * dy;
                        }
                        const dist = Math.sqrt(dist2);
                        const push = t.linkRepulsion / Math.max(1, dist2);
                        fx += (dx / dist) * push;
                        fy += (dy / dist) * push;
                    }
                }
            }
            a.vx = (a.vx + fx) * t.linkDamping;
            a.vy = (a.vy + fy) * t.linkDamping;
        }

        for (const [ai, bi] of adjacency) {
            const a = list[ai];
            const b = list[bi];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1e-4) {
                dx = hashUnit(a.id) - hashUnit(b.id) || 0.5;
                dy = 0.5;
                dist = Math.sqrt(dx * dx + dy * dy);
            }
            const force = t.linkSpring * (dist - t.linkSpringLength);
            const ux = (dx / dist) * force;
            const uy = (dy / dist) * force;
            a.vx += ux;
            a.vy += uy;
            b.vx -= ux;
            b.vy -= uy;
        }

        for (const node of list) {
            node.vx = Math.max(-t.linkMaxStep, Math.min(t.linkMaxStep, node.vx));
            node.vy = Math.max(-t.linkMaxStep, Math.min(t.linkMaxStep, node.vy));
            node.x = Math.max(-t.worldWidth, Math.min(t.worldWidth, node.x + node.vx));
            node.y = Math.max(-t.worldHeight, Math.min(t.worldHeight, node.y + node.vy));
        }
    }

    return new Map(list.map((node) => [node.id, { x: node.x, y: node.y, z: 0 }]));
}

function timestampOf(node: BrainNode): number | null {
    if (!node.changed) return null;
    const ms = Date.parse(node.changed);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * timeline — x is last-change (or run start), y is one lane per layer.
 *
 * A node without a usable timestamp keeps its layer lane but is pinned to the left edge, and the
 * renderer draws it hollow (`BRAIN_UNDATED_LABEL`). Folding it into the oldest bucket would claim
 * it changed at that time, and a separate "unknown" lane would make it look like a new layer —
 * both are the D3/D4 mistake of turning absence into a value.
 */
function layoutTimeline(nodes: BrainNode[]): Map<string, Vec3> {
    const positions = new Map<string, Vec3>();
    const stamps = nodes.map(timestampOf).filter((v): v is number => v != null);
    const min = stamps.length ? Math.min(...stamps) : 0;
    const max = stamps.length ? Math.max(...stamps) : 0;
    const span = Math.max(1, max - min);
    const laneCenter = (LAYER_ORDER.length - 1) / 2;
    const halfWidth = BRAIN_TUNING.worldWidth / 2 - BRAIN_TUNING.timelinePadding;

    for (const node of nodes) {
        const lane = layerIndex(node.layer);
        const ts = timestampOf(node);
        const y = (lane - laneCenter) * BRAIN_TUNING.timelineLaneGap;
        const x = ts == null ? -halfWidth : -halfWidth + ((ts - min) / span) * halfWidth * 2;
        positions.set(node.id, { x, y, z: 0 });
    }
    return positions;
}

/** orbit — the areas layout plus a deterministic depth per node; the renderer spins it. */
function layoutOrbit(nodes: BrainNode[]): Map<string, Vec3> {
    const flat = layoutAreas(nodes);
    const positions = new Map<string, Vec3>();
    for (const node of nodes) {
        const p = flat.get(node.id) ?? { x: 0, y: 0, z: 0 };
        const depth =
            node.kind === 'root' ? 0 : (hashUnit(node.id) * 2 - 1) * BRAIN_TUNING.orbitDepth;
        positions.set(node.id, { x: p.x, y: p.y, z: depth });
    }
    return positions;
}

export function layoutBrain(view: BrainView, doc: BrainGraphDocument | null | undefined): BrainLayout {
    const nodes = doc?.nodes ?? [];
    let positions: Map<string, Vec3>;
    switch (view) {
        case 'circle':
            positions = layoutCircle(nodes);
            break;
        case 'areas':
            positions = layoutAreas(nodes);
            break;
        case 'links':
            positions = layoutForce(nodes, doc?.links ?? [], layoutAreas(nodes));
            break;
        case 'timeline':
            positions = layoutTimeline(nodes);
            break;
        case 'orbit':
            positions = layoutOrbit(nodes);
            break;
        case 'rings':
        default:
            positions = layoutRings(nodes);
            break;
    }
    return { view, positions, bounds: boundsOf(positions) };
}

/** Legend/isolate sentinel for nodes the DB recorded without an area (runs, rules, harnesses). */
export const BRAIN_NO_AREA = '(no area)';

/**
 * Isolate one area and/or one kind. The root is always kept for orientation, and links are dropped
 * unless both ends survive — a filtered view must never draw an edge to something invisible.
 */
export function filterBrainGraph(
    doc: BrainGraphDocument | null,
    filter: { area?: string | null; kind?: BrainKind | null },
): BrainGraphDocument | null {
    if (!doc) return null;
    const area = filter.area ?? null;
    const kind = filter.kind ?? null;
    if (!area && !kind) return doc;
    const keep = new Set(
        doc.nodes
            .filter((node) => {
                if (node.kind === 'root') return true;
                if (area && (node.area ?? BRAIN_NO_AREA) !== area) return false;
                if (kind && node.kind !== kind) return false;
                return true;
            })
            .map((node) => node.id),
    );
    return {
        ...doc,
        nodes: doc.nodes.filter((node) => keep.has(node.id)),
        links: doc.links.filter((link) => keep.has(link.s) && keep.has(link.t)),
    };
}

/** Degree drives dot size; the map is shared by the renderer, legend and hit-test. */
export function radiusForNode(node: BrainNode): number {
    const { nodeRadiusMin, nodeRadiusMax } = BRAIN_TUNING;
    const degree = Math.max(0, node.degree);
    const scaled = nodeRadiusMin + Math.log2(1 + degree) * 2.4;
    return Math.min(nodeRadiusMax, scaled);
}

/** Shown in the legend: a hollow dot means the row carried no usable timestamp. */
export const BRAIN_UNDATED_LABEL = 'hollow dot = no timestamp';
