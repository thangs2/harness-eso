import type { BrainGraphDocument, BrainKind, BrainLayer } from '@/shared/api/types';
import { BRAIN_NO_AREA, LAYER_ORDER } from './brainLayout';
import { SHAPE_SAMPLES, areaColor, kindLabel } from './brainStyle';

const LAYER_LABEL: Record<BrainLayer, string> = {
    core: 'core',
    memory: 'memory',
    skills: 'skills',
    runs: 'runs',
    apps: 'apps',
};

/**
 * The legend is the only place that explains what a shape or colour means, and every chip is also
 * the isolate control — a filter that lives next to the thing it filters.
 */
export function BrainLegend({
    doc,
    areaFilter,
    kindFilter,
    onArea,
    onKind,
}: {
    doc: BrainGraphDocument;
    areaFilter: string | null;
    kindFilter: BrainKind | null;
    onArea: (area: string | null) => void;
    onKind: (kind: BrainKind | null) => void;
}) {
    const layerCounts = new Map<BrainLayer, number>();
    for (const node of doc.nodes) layerCounts.set(node.layer, (layerCounts.get(node.layer) ?? 0) + 1);

    const areaCounts = new Map<string, number>();
    for (const node of doc.nodes) {
        if (node.kind === 'area' || node.kind === 'root') continue;
        const key = node.area ?? BRAIN_NO_AREA;
        areaCounts.set(key, (areaCounts.get(key) ?? 0) + 1);
    }
    const areas = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    return (
        <div className="flex flex-col gap-3">
            <div>
                <p className="obs-sub m-0 mb-2">Layers</p>
                <ul className="m-0 p-0 list-none flex flex-col gap-1">
                    {LAYER_ORDER.map((layer) => (
                        <li key={layer} className="flex items-center justify-between gap-2 text-xs">
                            <span className="obs-mono">{LAYER_LABEL[layer]}</span>
                            <span className="obs-sub m-0">{layerCounts.get(layer) ?? 0}</span>
                        </li>
                    ))}
                </ul>
            </div>

            <div>
                <p className="obs-sub m-0 mb-2">Areas</p>
                <div className="flex flex-wrap gap-1">
                    {areas.map(([area, count]) => (
                        <button
                            key={area}
                            type="button"
                            className={`obs-btn obs-btn--ghost flow-tab${areaFilter === area ? ' flow-tab--on' : ''}`}
                            onClick={() => onArea(areaFilter === area ? null : area)}
                            title={`${count} node(s) in ${area}`}
                        >
                            <span
                                aria-hidden
                                style={{
                                    display: 'inline-block',
                                    width: 8,
                                    height: 8,
                                    borderRadius: 2,
                                    marginRight: 6,
                                    background: areaColor(area, area),
                                }}
                            />
                            {area === BRAIN_NO_AREA ? 'no area' : area}
                        </button>
                    ))}
                    {areaFilter ? (
                        <button type="button" className="obs-btn" onClick={() => onArea(null)}>
                            clear
                        </button>
                    ) : null}
                </div>
            </div>

            <div>
                <p className="obs-sub m-0 mb-2">Kinds</p>
                <div className="flex flex-wrap gap-1">
                    {SHAPE_SAMPLES.map((sample) => (
                        <button
                            key={sample.kind}
                            type="button"
                            className={`obs-btn obs-btn--ghost flow-tab${kindFilter === sample.kind ? ' flow-tab--on' : ''}`}
                            onClick={() => onKind(kindFilter === sample.kind ? null : sample.kind)}
                        >
                            {kindLabel(sample.kind)}
                        </button>
                    ))}
                </div>
            </div>

            <p className="obs-sub m-0">
                colour = area · shape = kind · size = degree. Degree is counted over the whole graph,
                even while a filter is on.
            </p>
        </div>
    );
}
