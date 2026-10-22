import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { BrainGraphDocument } from '@/shared/api/types';
import { hitTest } from './brainHitTest';
import { radiusForNode, type BrainLayout } from './brainLayout';
import { BRAIN_TUNING } from './brainTuning';
import { projectPoint, zoomAt, type Camera, type Viewport } from './brainProjection';
import {
    BRAIN_BACKGROUND,
    EDGE_COLOR,
    LABEL_FILL,
    SELECTED_RING,
    areaColor,
    drawKindShape,
    labelCapacity,
} from './brainStyle';

/**
 * The only canvas in the feature. Geometry comes from the pure layout module (tested in
 * brainLayout.test.ts); this component owns pixels, pointer maths and the animation clock.
 *
 * It deliberately does not use G6. G6 drives the request-detail graph/topology tabs, where the
 * question is "which step called which". Here the question is "what does the whole workspace look
 * like", and a bespoke renderer keeps six projections plus a 2.5D orbit in one coordinate system
 * without fighting a general graph engine — and without pulling a second layout engine in.
 */
export function BrainCanvas({
    doc,
    layout,
    size,
    camera,
    onCamera,
    selectedId,
    onSelect,
    names,
    motion,
    height,
}: {
    doc: BrainGraphDocument;
    layout: BrainLayout;
    size: Viewport;
    camera: Camera;
    onCamera: (camera: Camera) => void;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    names: boolean;
    motion: boolean;
    height: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const projectedRef = useRef(new Map<string, { x: number; y: number; scale: number; depth: number }>());
    const rotationRef = useRef(0);
    const hoverRef = useRef<string | null>(null);
    const dragRef = useRef({ x: 0, y: 0, moved: false, active: false });

    // D5: a cap that is printed must also be applied — otherwise the picture silently claims to be
    // the whole graph. Past the cap the highest-degree nodes win, and the page says so.
    const nodes = useMemo(() => {
        if (doc.nodes.length <= BRAIN_TUNING.maxRenderNodes) return doc.nodes;
        return [...doc.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, BRAIN_TUNING.maxRenderNodes);
    }, [doc.nodes]);
    const links = doc.links;
    const view = layout.view;

    const adjacency = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const link of links) {
            if (!map.has(link.s)) map.set(link.s, new Set());
            if (!map.has(link.t)) map.set(link.t, new Set());
            map.get(link.s)!.add(link.t);
            map.get(link.t)!.add(link.s);
        }
        return map;
    }, [links]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const width = Math.max(1, size.width);
        const heightPx = Math.max(1, size.height);
        if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
        if (canvas.height !== Math.round(heightPx * dpr)) canvas.height = Math.round(heightPx * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = BRAIN_BACKGROUND;
        ctx.fillRect(0, 0, width, heightPx);

        const rotation = rotationRef.current;
        const projected = new Map<string, { x: number; y: number; scale: number; depth: number }>();
        for (const node of nodes) {
            const point = layout.positions.get(node.id);
            if (!point) continue;
            projected.set(node.id, projectPoint(point, camera, size, rotation));
        }
        projectedRef.current = projected;

        const drawnIds = new Set(nodes.map((node) => node.id));
        const focusId = hoverRef.current ?? selectedId;
        const focusSet = focusId ? new Set([focusId, ...(adjacency.get(focusId) ?? [])]) : null;
        const alphaFor = (id: string) =>
            focusSet && !focusSet.has(id) ? BRAIN_TUNING.hoverDimAlpha : 1;

        ctx.lineWidth = 1;
        for (const link of links) {
            const a = projected.get(link.s);
            const b = projected.get(link.t);
            if (!a || !b || !drawnIds.has(link.s) || !drawnIds.has(link.t)) continue;
            const active = focusSet ? focusSet.has(link.s) && focusSet.has(link.t) : false;
            const alpha =
                BRAIN_TUNING.edgeAlpha *
                (active ? 2.2 : 1) *
                Math.min(alphaFor(link.s), alphaFor(link.t)) *
                Math.min(1.4, Math.max(0.5, (a.scale + b.scale) / 2));
            ctx.strokeStyle = `rgba(${EDGE_COLOR}, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        const sorted = [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id));
        for (const node of sorted) {
            const p = projected.get(node.id);
            if (!p) continue;
            const radius = radiusForNode(node) * Math.min(1.6, Math.max(0.5, p.scale));
            const color = areaColor(node.area, node.layer);
            // In the timeline an undated node is hollow: no timestamp is a fact, and it must not
            // look like "changed at the oldest date" (D3/D4).
            const hollow = view === 'timeline' && !node.changed;
            ctx.globalAlpha = alphaFor(node.id);
            ctx.strokeStyle = color;
            ctx.fillStyle = hollow ? 'transparent' : node.kind === 'note' ? `${color}55` : color;
            ctx.lineWidth = node.id === selectedId ? 2.4 : node.id === hoverRef.current ? 2 : 1.1;
            drawKindShape(ctx, node.kind, p.x, p.y, radius, hollow);
            if (node.id === selectedId) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2);
                ctx.strokeStyle = SELECTED_RING;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        if (labelCapacity(camera.zoom, names)) {
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textBaseline = 'middle';
            let drawn = 0;
            for (const node of sorted) {
                if (drawn >= BRAIN_TUNING.labelMaxCount) break;
                const p = projected.get(node.id);
                if (!p) continue;
                const radius = radiusForNode(node) * Math.min(1.6, Math.max(0.5, p.scale));
                ctx.globalAlpha = alphaFor(node.id) * (focusSet ? 1 : 0.9);
                ctx.fillStyle = LABEL_FILL;
                ctx.fillText(truncate(node.label, 34), p.x + radius + 4, p.y);
                drawn += 1;
            }
            ctx.globalAlpha = 1;
        }
    }, [adjacency, camera, layout, links, names, nodes, selectedId, size, view]);

    useEffect(() => {
        draw();
    }, [draw]);

    const animate = motion && view === 'orbit';
    useEffect(() => {
        if (!animate) return;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            rotationRef.current += (now - last) * BRAIN_TUNING.orbitSpeed;
            last = now;
            draw();
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [animate, draw]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            onCamera(zoomAt(camera, size, anchor, camera.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, [camera, onCamera, size]);

    const localPoint = (event: { clientX: number; clientY: number }) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    };

    return (
        <canvas
            ref={canvasRef}
            style={{ width: '100%', height, display: 'block', borderRadius: 8, cursor: 'grab' }}
            onPointerDown={(event) => {
                const p = localPoint(event);
                dragRef.current = { x: p.x, y: p.y, moved: false, active: true };
                (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
                const p = localPoint(event);
                if (dragRef.current.active) {
                    const dx = p.x - dragRef.current.x;
                    const dy = p.y - dragRef.current.y;
                    if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
                    if (dragRef.current.moved) {
                        dragRef.current.x = p.x;
                        dragRef.current.y = p.y;
                        onCamera({ ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom });
                        return;
                    }
                }
                const hit = hitTest(nodes, projectedRef.current, p);
                const id = hit?.id ?? null;
                if (id !== hoverRef.current) {
                    hoverRef.current = id;
                    draw();
                }
            }}
            onPointerUp={(event) => {
                const wasDrag = dragRef.current.moved;
                dragRef.current.active = false;
                if (wasDrag) return;
                const hit = hitTest(nodes, projectedRef.current, localPoint(event));
                onSelect(hit?.id ?? null);
            }}
            onPointerLeave={() => {
                dragRef.current.active = false;
                if (hoverRef.current) {
                    hoverRef.current = null;
                    draw();
                }
            }}
            onDoubleClick={(event) => {
                const hit = hitTest(nodes, projectedRef.current, localPoint(event));
                if (!hit) return;
                const point = layout.positions.get(hit.id);
                if (point) onCamera({ x: point.x, y: point.y, zoom: Math.max(camera.zoom, 1.8) });
            }}
            aria-label="Brain graph"
            role="img"
        />
    );
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
