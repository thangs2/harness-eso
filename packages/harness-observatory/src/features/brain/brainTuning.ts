/**
 * Every speed, radius and count the Brain views use. Tuning a view means changing one number
 * here — nothing in the renderer hard-codes a magic constant (Card 5's "one constant block").
 */
export const BRAIN_TUNING = {
    /** Layout box the views are laid out in before the camera is fitted. */
    worldWidth: 1600,
    worldHeight: 1000,

    /** rings: the root sits in the middle, each layer is one ring further out. */
    ringStart: 120,
    ringGap: 132,

    /** circle: every node on one ring. */
    circleRadius: 520,

    /** areas: one cluster per area, clusters on a big circle. */
    areaRingRadius: 430,
    areaClusterRadius: 96,
    goldenAngle: 2.399963229728653,

    /** links: deterministic force pass. Runs once per view switch, never per frame. */
    linkIterations: 220,
    linkSpring: 0.012,
    linkSpringLength: 70,
    linkRepulsion: 2400,
    linkDamping: 0.82,
    linkMaxStep: 24,
    /** Uniform-grid repulsion: a node only sees its own cell and the 8 neighbours. */
    linkGridFactor: 1.4,

    /** timeline: x = day bucket, y = one lane per layer. */
    timelineLaneGap: 96,
    timelinePadding: 80,

    /** orbit: 2.5D depth, rotated by the renderer. */
    orbitDepth: 260,
    orbitSpeed: 0.00018,
    orbitTilt: 0.42,

    /** Camera. */
    focal: 1100,
    zoomMin: 0.25,
    zoomMax: 5,
    zoomFitPadding: 0.9,

    /** Nodes and labels. */
    nodeRadiusMin: 3.4,
    nodeRadiusMax: 15,
    labelMaxCount: 90,
    labelMinZoom: 1.1,
    hoverDimAlpha: 0.14,
    edgeAlpha: 0.22,

    /** Safety valve: above this the renderer draws the top-degree nodes and says so. */
    maxRenderNodes: 4000,
} as const;

export type BrainTuning = typeof BRAIN_TUNING;
