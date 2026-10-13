import { useState } from 'react';
import { getDiagram, PIPELINE_DIAGRAMS, type DiagramId } from '@/diagrams/pipeline-diagrams';
import { MermaidPanel } from '@/components/MermaidPanel';

const QUICK_LINKS: Array<{ id: DiagramId; label: string }> = [
    { id: 'v2-abcd', label: 'A → D (một turn)' },
    { id: 'v1-coordinates', label: 'Phase + L0–L4' },
    { id: 'v3-layers', label: 'Thang L0 → L4' },
    { id: 'taxonomy-bridge', label: 'A → B C D → ACT' },
];

type Props = {
    defaultDiagramId?: string;
    primaryLabel?: string;
};

export function PipelineIntro({ defaultDiagramId = 'v2-abcd', primaryLabel }: Props) {
    const [openId, setOpenId] = useState<DiagramId | null>(null);
    const primary = getDiagram(defaultDiagramId);

    function toggle(id: DiagramId) {
        setOpenId((cur) => (cur === id ? null : id));
    }

    return (
        <section className="pipeline-intro callout">
            <p className="pipeline-intro__lead">
                Một turn Harness chạy <strong>Phase A</strong> (surface) → <strong>B</strong> (collect) →{' '}
                <strong>C</strong> (measure) → <strong>D</strong> (escalate) → rồi <strong>ACT</strong> (Brain L4).
                Các lựa chọn plug-in bên dưới map vào các bước đó — bấm gợi ý hoặc diagram để xem.
            </p>
            <div className="pipeline-intro__actions">
                {primary && (
                    <button
                        type="button"
                        className="secondary"
                        onClick={() => toggle(primary.id)}
                    >
                        {primaryLabel || 'Xem pipeline Phase A → D'}
                    </button>
                )}
                {QUICK_LINKS.filter((l) => l.id !== primary?.id).map((l) => (
                    <button key={l.id} type="button" className="linkish" onClick={() => toggle(l.id)}>
                        {l.label}
                    </button>
                ))}
            </div>
            {openId && PIPELINE_DIAGRAMS[openId] && (
                <MermaidPanel diagram={PIPELINE_DIAGRAMS[openId]} onClose={() => setOpenId(null)} />
            )}
        </section>
    );
}
