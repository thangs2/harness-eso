import type { BrainKind } from '@/shared/api/types';
import { hashString } from './brainLayout';
import { BRAIN_TUNING } from './brainTuning';
import { AREA_PALETTE, TOKENS } from './brainTokens';

/**
 * Colour, shape and label vocabulary for the Brain views — shared by canvas, legend and card.
 * All colours come from `brainTokens.ts` (the app's own design system); this file only decides
 * which token goes where.
 */

export const BRAIN_BACKGROUND = TOKENS.bgCanvas;
export const EDGE_COLOR = TOKENS.edge.replace('#', '')
    .match(/.{2}/g)!
    .map((hex) => Number.parseInt(hex, 16))
    .join(', ');

export function areaColor(area: string | null | undefined, fallbackKey: string): string {
    const key = area ?? fallbackKey;
    return AREA_PALETTE[hashString(key) % AREA_PALETTE.length];
}

/** Selection ring and active dot use the app's "active node" green, not an ad-hoc colour. */
export const SELECTED_RING = TOKENS.nodeActiveStroke;
export const HOLLOW_STROKE = TOKENS.labelDim;

export const KIND_SHAPE: Record<BrainKind, 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon' | 'rect'> = {
    root: 'hexagon',
    area: 'square',
    note: 'circle',
    skill: 'diamond',
    tool: 'triangle',
    run: 'circle',
    app: 'rect',
};

export const KIND_LABEL: Record<BrainKind, string> = {
    root: 'root / project',
    area: 'area',
    note: 'file',
    skill: 'rule',
    tool: 'tool',
    run: 'run',
    app: 'harness',
};

export function kindLabel(kind: BrainKind): string {
    return KIND_LABEL[kind] ?? kind;
}

function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rotation = 0) {
    ctx.beginPath();
    for (let i = 0; i < sides; i += 1) {
        const angle = rotation + (i / sides) * Math.PI * 2;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

/** One shape per kind so a black-and-white screenshot still reads. */
export function drawKindShape(
    ctx: CanvasRenderingContext2D,
    kind: BrainKind,
    x: number,
    y: number,
    r: number,
    hollow = false,
) {
    const shape = KIND_SHAPE[kind] ?? 'circle';
    switch (shape) {
        case 'square':
            ctx.beginPath();
            ctx.rect(x - r, y - r, r * 2, r * 2);
            break;
        case 'rect':
            ctx.beginPath();
            ctx.rect(x - r * 1.4, y - r * 0.75, r * 2.8, r * 1.5);
            break;
        case 'diamond':
            polygon(ctx, x, y, r * 1.25, 4, Math.PI / 4);
            break;
        case 'triangle':
            polygon(ctx, x, y, r * 1.3, 3, -Math.PI / 2);
            break;
        case 'hexagon':
            polygon(ctx, x, y, r * 1.2, 6, Math.PI / 6);
            break;
        case 'circle':
        default:
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            break;
    }
    if (hollow) {
        ctx.stroke();
    } else {
        ctx.fill();
        ctx.stroke();
    }
}

export const SHAPE_SAMPLES: { kind: BrainKind; label: string }[] = [
    { kind: 'root', label: 'project' },
    { kind: 'area', label: 'area' },
    { kind: 'note', label: 'file' },
    { kind: 'skill', label: 'rule' },
    { kind: 'tool', label: 'tool' },
    { kind: 'run', label: 'run' },
    { kind: 'app', label: 'harness' },
];

export const LABEL_FILL = TOKENS.label;

/** Node radius for the label pass — the same rule the layout uses for hit-testing. */
export function labelCapacity(zoom: number, names: boolean): boolean {
    return names || zoom >= BRAIN_TUNING.labelMinZoom;
}
