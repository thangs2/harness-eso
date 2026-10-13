import type { ReactNode } from 'react';
import type { BadgeTone } from '@/ui/statusTone';
import { sufficiencyTone as sufficiencyToneFn } from '@/ui/statusTone';

export type { BadgeTone };

/**
 * Tone → class, written as COMPLETE literals on purpose.
 *
 * Tailwind tree-shakes rules added in `@layer components` by scanning source files for
 * candidate class names. `obs-badge--${tone}` is not extractable, so
 * `.obs-badge--neutral/ok/warn/danger/info` were dropped from the stylesheet entirely and
 * every badge rendered with a transparent background and inherited text colour — the
 * `completed` pill was indistinguishable from plain text. Spelling the classes out here is
 * what keeps those rules in the build; do not reintroduce interpolation.
 */
const TONE_CLASS: Record<BadgeTone, string> = {
    neutral: 'obs-badge--neutral',
    ok: 'obs-badge--ok',
    warn: 'obs-badge--warn',
    danger: 'obs-badge--danger',
    info: 'obs-badge--info',
};

export function Badge({
    children,
    tone = 'neutral',
    dot,
}: {
    children: ReactNode;
    tone?: BadgeTone;
    /** Status pill with leading color dot (list / header) */
    dot?: boolean;
}) {
    const classes = ['obs-badge', TONE_CLASS[tone] ?? TONE_CLASS.neutral];
    if (dot) classes.push('obs-badge--dot');
    return <span className={classes.join(' ')}>{children}</span>;
}

export const sufficiencyTone = sufficiencyToneFn;
