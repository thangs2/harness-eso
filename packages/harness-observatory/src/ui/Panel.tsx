import type { ReactNode } from 'react';

export type PanelProps = {
    title?: string;
    /** One-line explanation under the title — what this card is for, not what it contains. */
    lede?: string;
    /** Right-aligned status pills for the head. */
    badges?: ReactNode;
    /** Bottom summary separated by a hairline — counts, source, caveats. */
    footer?: ReactNode;
    /** Accent rail colour. Each card category picks one so the row reads as categorised. */
    accent?: string;
    className?: string;
    children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'children' | 'className'>;

/**
 * The single card chrome for the Observatory. Every panel on a page uses this so a row of
 * them reads as one system instead of unrelated boxes, and so categorisation is carried by
 * the accent rail rather than by a second set of bespoke rules.
 */
export function Panel({
    title,
    lede,
    badges,
    footer,
    accent,
    className = '',
    children,
    ...rest
}: PanelProps) {
    const hasHead = Boolean(title || badges);
    return (
        <section
            className={`obs-card ${className}`.trim()}
            style={accent ? ({ ['--card-accent' as string]: accent } as React.CSSProperties) : undefined}
            {...rest}
        >
            {hasHead ? (
                <header className="obs-card-head">
                    <div>
                        {title ? <h3 className="obs-card-title">{title}</h3> : null}
                        {lede ? <p className="obs-card-lede">{lede}</p> : null}
                    </div>
                    {badges ? <div className="obs-card-badges">{badges}</div> : null}
                </header>
            ) : null}
            <div className={hasHead ? 'obs-card-body' : undefined}>{children}</div>
            {footer ? <footer className="obs-card-foot">{footer}</footer> : null}
        </section>
    );
}
