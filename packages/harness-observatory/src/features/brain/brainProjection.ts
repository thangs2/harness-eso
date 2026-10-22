import { BRAIN_TUNING } from './brainTuning';
import type { BrainBounds, Vec3 } from './brainLayout';

/** Camera and projection — the only place world coordinates become pixels. */
export interface Camera {
    /** World-space centre the camera looks at. */
    x: number;
    y: number;
    zoom: number;
}

export interface Viewport {
    width: number;
    height: number;
}

export interface ProjectedPoint {
    x: number;
    y: number;
    /** Perspective scale at this depth — the renderer uses it for dot size and label opacity. */
    scale: number;
    depth: number;
}

export function rotateY(point: Vec3, angle: number): Vec3 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
        x: point.x * cos + point.z * sin,
        y: point.y,
        z: -point.x * sin + point.z * cos,
    };
}

export function projectPoint(
    point: Vec3,
    camera: Camera,
    viewport: Viewport,
    rotation = 0,
): ProjectedPoint {
    const rotated = rotateY(point, rotation);
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    const depth = rotated.z;
    const perspective = BRAIN_TUNING.focal / Math.max(1, BRAIN_TUNING.focal + depth);
    return {
        x: cx + (rotated.x - camera.x) * perspective * camera.zoom,
        y: cy + (rotated.y - camera.y) * perspective * camera.zoom,
        scale: perspective * camera.zoom,
        depth,
    };
}

/** Frame everything: zoom so the bounds fit, centred on them. */
export function fitCamera(bounds: BrainBounds, viewport: Viewport): Camera {
    const worldWidth = Math.max(1, bounds.maxX - bounds.minX);
    const worldHeight = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = Math.min(
        BRAIN_TUNING.zoomMax,
        Math.max(
            BRAIN_TUNING.zoomMin,
            Math.min(
                (viewport.width / worldWidth) * BRAIN_TUNING.zoomFitPadding,
                (viewport.height / worldHeight) * BRAIN_TUNING.zoomFitPadding,
            ),
        ),
    );
    return {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
        zoom,
    };
}

/** Zoom around a screen anchor, so the world point under the cursor stays put. */
export function zoomAt(camera: Camera, viewport: Viewport, anchor: { x: number; y: number }, nextZoom: number): Camera {
    const zoom = Math.min(BRAIN_TUNING.zoomMax, Math.max(BRAIN_TUNING.zoomMin, nextZoom));
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    const worldX = (anchor.x - cx) / camera.zoom + camera.x;
    const worldY = (anchor.y - cy) / camera.zoom + camera.y;
    return {
        zoom,
        x: worldX - (anchor.x - cx) / zoom,
        y: worldY - (anchor.y - cy) / zoom,
    };
}

/** Move the camera so one node sits in the middle (the card's "fly to" action). */
export function cameraForNode(point: Vec3, viewport: Viewport): Camera {
    const fit = fitCamera(
        { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y, minZ: 0, maxZ: 0 },
        viewport,
    );
    return { x: point.x, y: point.y, zoom: Math.max(fit.zoom, 1.6) };
}
