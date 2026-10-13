import { useEffect, useId, useRef, useState } from 'react';
import mermaid from 'mermaid';
import type { PipelineDiagram } from '@/diagrams/pipeline-diagrams';

let mermaidReady = false;

function ensureMermaid() {
    if (mermaidReady) return;
    mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'system-ui, sans-serif',
    });
    mermaidReady = true;
}

export function MermaidPanel({ diagram, onClose }: { diagram: PipelineDiagram; onClose?: () => void }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const reactId = useId().replace(/:/g, '');
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        ensureMermaid();
        const el = hostRef.current;
        if (!el) return;
        let cancelled = false;
        setErr(null);
        void mermaid
            .render(`mmd-${reactId}`, diagram.mermaid)
            .then(({ svg }) => {
                if (cancelled || !hostRef.current) return;
                hostRef.current.innerHTML = svg;
            })
            .catch((e) => {
                if (!cancelled) setErr((e as Error).message);
            });
        return () => {
            cancelled = true;
        };
    }, [diagram.mermaid, reactId]);

    return (
        <div className="mermaid-panel" role="dialog" aria-label={diagram.title}>
            <header className="mermaid-panel__head">
                <div>
                    <strong>{diagram.title}</strong>
                    <span className="sub"> — {diagram.source}</span>
                </div>
                {onClose && (
                    <button type="button" className="secondary" onClick={onClose}>Đóng</button>
                )}
            </header>
            {err ? <p className="error">{err}</p> : <div className="mermaid-panel__svg" ref={hostRef} />}
        </div>
    );
}
