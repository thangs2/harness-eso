import { useState } from 'react';
import { getDiagram, type DiagramId } from '@/diagrams/pipeline-diagrams';
import { MermaidPanel } from '@/components/MermaidPanel';

type Props = {
    diagramId: DiagramId | string;
    children: React.ReactNode;
};

export function DiagramHint({ diagramId, children }: Props) {
    const [open, setOpen] = useState(false);
    const diagram = getDiagram(diagramId);

    if (!diagram) {
        return <span className="hint">{children}</span>;
    }

    return (
        <span className="diagram-hint-wrap">
            <button type="button" className="hint-link" onClick={() => setOpen((v) => !v)}>
                {children}
            </button>
            {open && <MermaidPanel diagram={diagram} onClose={() => setOpen(false)} />}
        </span>
    );
}
