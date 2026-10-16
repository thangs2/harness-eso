export type IdeKind = 'cursor' | 'antigravity' | 'unknown' | string;

export function normalizeIde(ide?: string | null): { key: 'cursor' | 'antigravity' | 'unknown'; label: string } {
    if (!ide) return { key: 'unknown', label: 'Unknown' };
    const lower = ide.toLowerCase();
    if (lower.includes('antigravity') || lower.includes('gemini') || lower.includes('brain')) {
        return { key: 'antigravity', label: 'Antigravity' };
    }
    if (lower.includes('cursor')) {
        return { key: 'cursor', label: 'Cursor' };
    }
    return { key: 'unknown', label: ide.charAt(0).toUpperCase() + ide.slice(1) };
}

export function IdeBadge({
    ide,
    size = 'default',
    showDot = true,
}: {
    ide?: string | null;
    size?: 'default' | 'sm';
    showDot?: boolean;
}) {
    const { key, label } = normalizeIde(ide);
    const toneClass =
        key === 'cursor'
            ? 'obs-badge--cursor'
            : key === 'antigravity'
              ? 'obs-badge--antigravity'
              : 'obs-badge--neutral';

    const sizeClass = size === 'sm' ? 'text-[11px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';

    return (
        <span
            className={`obs-badge ${toneClass} ${showDot ? 'obs-badge--dot' : ''} ${sizeClass}`}
            title={`IDE: ${label}`}
        >
            {label}
        </span>
    );
}
