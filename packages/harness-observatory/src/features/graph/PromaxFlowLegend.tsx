import type { FlowGraphVm } from '@/shared/api/types';
import {
    RULE_BUCKET_LABEL,
    RULE_BUCKET_ORDER,
    STAGE_LABEL,
    STAGE_ORDER,
    STAGE_HEX,
    RULE_BUCKET_HEX,
} from './promaxFlowStyles';

export function PromaxFlowLegend({ graph }: { graph: FlowGraphVm }) {
    const nodes = graph.nodes ?? [];
    const kinds = new Set<string>();
    const stages: string[] = [];
    for (const n of nodes) {
        const k = String(n.data?.kind ?? '');
        if (k === 'step' || k === 'hub') {
            const st = String(n.data?.stage ?? '');
            if (st && !stages.includes(st)) stages.push(st);
            kinds.add(k);
        } else if (k) kinds.add(k);
    }
    const order = STAGE_ORDER.filter((s) => stages.includes(s));
    const ruleBuckets = new Set<string>();
    for (const n of nodes) {
        if (n.data?.kind === 'rule' && n.data?.ruleBucket) {
            ruleBuckets.add(String(n.data.ruleBucket));
        }
    }

    const parts: { color: string; label: string }[] = [];
    if (kinds.has('root')) parts.push({ color: '#e5e7eb', label: 'prompt' });
    for (const st of order) {
        parts.push({ color: STAGE_HEX[st] || '#8b97ab', label: STAGE_LABEL[st] || st });
    }
    for (const b of RULE_BUCKET_ORDER) {
        if (!ruleBuckets.has(b)) continue;
        parts.push({ color: RULE_BUCKET_HEX[b] || '#c084fc', label: RULE_BUCKET_LABEL[b] || b });
    }
    if (kinds.has('hub')) parts.push({ color: '#8b97ab', label: 'stage hub' });
    if (kinds.has('step')) parts.push({ color: '#3d4f63', label: 'each call / file' });

    if (!parts.length) return null;

    return (
        <div className="promax-flow-legend chips" id="d-legend">
            {parts.map((p) => (
                <span key={p.label} className="lg">
                    <i style={{ background: p.color }} />
                    {p.label}
                </span>
            ))}
        </div>
    );
}
