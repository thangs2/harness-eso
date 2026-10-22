import type { BrainNode } from '@/shared/api/types';
import { radiusForNode } from './brainLayout';
import type { ProjectedPoint } from './brainProjection';

/**
 * Screen-space hit test. Pure: the canvas keeps the projection it just drew and the click asks
 * this function, so "the node under the cursor" is decided by the same numbers that were painted
 * (rather than by a second, drifting layout).
 */
export function hitTest(
    nodes: BrainNode[],
    projected: Map<string, ProjectedPoint>,
    point: { x: number; y: number },
    padding = 4,
): BrainNode | null {
    let best: BrainNode | null = null;
    let bestDistance = Infinity;
    for (const node of nodes) {
        const p = projected.get(node.id);
        if (!p) continue;
        const radius = radiusForNode(node) * Math.min(1.6, Math.max(0.5, p.scale)) + padding;
        const dx = p.x - point.x;
        const dy = p.y - point.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= radius && distance < bestDistance) {
            best = node;
            bestDistance = distance;
        }
    }
    return best;
}
