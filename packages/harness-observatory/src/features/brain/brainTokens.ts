/**
 * Colour + type tokens for the Brain page.
 *
 * Source of truth is the UI that already ships in this app — `tailwind.config.js`, `src/index.css`
 * and the G6 panel used by the request detail page — **not** the reference dashboard. The reference
 * contributes layout grammar (three columns, hairline sections, chips); it does not contribute
 * colour, because this product already has a palette operators recognise from the detail page.
 *
 * Rule: area colour appears only on dots, chip rings and label underlines. Surfaces and text stay
 * neutral, and the blue accent is reserved for interaction — never for data.
 */
export const TOKENS = {
    /** page background — tailwind `surface.DEFAULT` */
    bg: '#0b0e14',
    /** graph canvas — G6GraphPanel canvas fill, slightly deeper than the page */
    bgCanvas: '#0f121a',
    /** rail / card surface — `surface.raised` */
    panel: '#131722',
    /** hairline, card border — `surface.border` */
    border: '#253047',
    /** secondary hairline / grid — G6GraphPanel combo stroke */
    borderSoft: '#2a3142',
    /** body text */
    text: '#cbd5e1',
    /** strongest text — G6 labelFill */
    textStrong: '#e2e8f0',
    /** meta, inactive tabs — `.obs-sub` */
    textDim: '#8b97ab',
    /** faint captions */
    textFaint: '#64748b',
    /** interaction colour — `accent.soft` */
    accent: '#5aa9ff',
    /** active chip background — `accent.DEFAULT` */
    accentDeep: '#2f4a7a',
    ok: '#4ec97a',
    warn: '#e0b341',
    danger: '#ff6b6b',
    /** graph node body — G6GraphPanel */
    nodeFill: '#252b36',
    nodeStroke: '#3d4654',
    nodeActiveFill: '#1a3d2e',
    nodeActiveStroke: '#4ec97a',
    /** graph edges — G6GraphPanel */
    edge: '#4b5563',
    /** node labels */
    label: '#e2e8f0',
    /** secondary labels (edge, axis) */
    labelDim: '#94a3b8',
} as const;

/**
 * Categorical hues already used by the app's flow graph (`promaxFlowStyles.ts STAGE_HEX`).
 * Order matters: the hash picks by index, so the same area keeps the same colour across reloads.
 */
export const AREA_PALETTE = [
    '#c084fc',
    '#5aa9ff',
    '#4ec97a',
    '#22d3ee',
    '#38bdf8',
    '#e0b341',
    '#f472b6',
    '#fb7185',
    '#a78bfa',
    '#fab387',
    '#8b97ab',
] as const;
