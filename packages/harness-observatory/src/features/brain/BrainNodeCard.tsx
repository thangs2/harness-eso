import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBrainFile } from '@/shared/api/client';
import type { BrainFileResponse, BrainNode } from '@/shared/api/types';
import { kindLabel } from './brainStyle';
import { TOKENS } from './brainTokens';

/**
 * Inspector for one node. Read-only by design: copy, navigate, and (for a file node) look at the
 * text through the guarded `/api/brain/file` route. It never writes and never caches the preview
 * beyond this card's lifetime.
 */
export function BrainNodeCard({
    node,
    onClose,
    onFlyTo,
}: {
    node: BrainNode;
    onClose: () => void;
    onFlyTo: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const [preview, setPreview] = useState<BrainFileResponse | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const requestId = node.kind === 'run' ? node.id.replace(/^run:/, '') : null;

    const copy = async () => {
        const text = node.pathHost ?? node.path ?? node.id;
        try {
            await navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };

    const open = async () => {
        if (!node.path) return;
        setBusy(true);
        setPreviewError(null);
        try {
            // The id, not the path: the server resolves it against the graph it already served.
            setPreview(await fetchBrainFile(node.id));
        } catch (error) {
            setPreview(null);
            setPreviewError((error as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="obs-panel" data-testid="brain-node-card">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <h3 className="obs-card-title m-0" style={{ wordBreak: 'break-word' }}>
                        {node.label}
                    </h3>
                    <p className="obs-sub m-0 mt-1">
                        <span className="obs-pill">{kindLabel(node.kind)}</span> · layer{' '}
                        <span className="obs-mono">{node.layer}</span> · degree{' '}
                        <span className="obs-mono">{node.degree}</span>
                    </p>
                </div>
                <button type="button" className="obs-btn obs-btn--ghost" onClick={onClose} aria-label="Close node card">
                    ×
                </button>
            </div>

            {node.pathHost ?? node.path ? (
                <p className="obs-mono text-xs mt-2 mb-1" style={{ wordBreak: 'break-all' }}>
                    {node.pathHost ?? node.path}
                </p>
            ) : null}
            {node.note ? <p className="obs-sub m-0 mt-1">{node.note}</p> : null}
            {node.changed ? (
                <p className="obs-sub m-0 mt-1">
                    last change <span className="obs-mono">{node.changed}</span>
                </p>
            ) : (
                <p className="obs-sub m-0 mt-1">no timestamp recorded</p>
            )}

            <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" className="obs-btn" onClick={onFlyTo}>
                    Fly to
                </button>
                {node.path ? (
                    <button type="button" className="obs-btn obs-btn--ghost" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy path'}
                    </button>
                ) : null}
                {node.path && node.previewable ? (
                    <button
                        type="button"
                        className="obs-btn obs-btn--ghost"
                        onClick={() => void open()}
                        disabled={busy}
                    >
                        {busy ? 'Opening…' : 'Open file'}
                    </button>
                ) : null}
                {node.path && !node.previewable ? (
                    <span className="obs-sub m-0" title="Directories and paths outside the mounted repo are not previewable">
                        not readable from the server
                    </span>
                ) : null}
                {requestId ? (
                    <Link className="obs-btn obs-btn--ghost" to={`/requests/${encodeURIComponent(requestId)}`}>
                        Open request
                    </Link>
                ) : null}
            </div>

            {previewError ? (
                <p className="obs-error m-0 mt-3" role="alert">
                    {previewError}
                </p>
            ) : null}

            {preview ? (
                <div className="mt-3">
                    <p className="obs-sub m-0 mb-1">
                        <span className="obs-mono">{preview.relativePath}</span> · showing{' '}
                        {preview.shownBytes} of {preview.bytes} bytes
                        {preview.truncated ? ' (truncated at the preview cap)' : ''}
                    </p>
                    <pre
                        className="obs-mono text-xs m-0 p-2"
                        style={{
                            maxHeight: 260,
                            overflow: 'auto',
                            background: TOKENS.bgCanvas,
                            border: `1px solid ${TOKENS.border}`,
                            borderRadius: 6,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {preview.text}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}
