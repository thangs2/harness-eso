import type { RequestConsentVm } from '@/shared/api/types';
import { Badge } from '@/ui/Badge';
import { Panel } from '@/ui/Panel';
import { consentOutcomeTone, gateModeTone, sufficiencyTone } from '@/ui/statusTone';

export type ConsentGateCardProps = RequestConsentVm;

const GATE_LABEL: Record<string, string> = {
    warn_only: 'warn only',
    consent: 'consent',
    deny: 'deny',
};

const OUTCOME_LABEL: Record<string, string> = {
    stop: 'Stop',
    continue: 'Continue',
    pending: 'awaiting choice',
};

/** Choices the gate offers, in the order the operator sees them. */
const CHOICES = ['stop', 'continue'] as const;

/**
 * Whether the gate has anything to report. Exported so the page can lay out around the card
 * instead of rendering an empty half-column next to Tokens when this returns false.
 */
export function shouldShowConsentCard(vm: RequestConsentVm): boolean {
    const level = vm.eso?.sufficiency;
    const gate = vm.policySnapshot?.eso?.cognition?.insufficientPromptGate;
    if (level && level !== 'sufficient') return true;
    if (gate === 'consent' || gate === 'deny') return true;
    if ((vm.eso?.gaps?.length ?? 0) > 0) return true;
    return false;
}

/** ESO scores are ratios; the raw value arrives as 0.3666666666666667. */
function formatScore(score: number | null | undefined): string | null {
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    return score.toFixed(2);
}

function toPercent(value: number): string {
    const clamped = Math.max(0, Math.min(1, value));
    return `${(clamped * 100).toFixed(2)}%`;
}

export function ConsentGateCard(vm: ConsentGateCardProps) {
    if (!shouldShowConsentCard(vm)) return null;

    const level = vm.eso?.sufficiency ?? 'unknown';
    const score = vm.eso?.score;
    const scoreText = formatScore(score);
    const hasScore = scoreText != null;
    const gaps = vm.eso?.gaps ?? [];
    const playbook = vm.eso?.recoveryPlaybook ?? [];

    const gate = vm.policySnapshot?.eso?.cognition?.insufficientPromptGate ?? 'consent';
    const writes = vm.policySnapshot?.eso?.enforceWrites;
    const esoMode = vm.policySnapshot?.eso?.mode;
    const thresholds = vm.policySnapshot?.eso?.thresholds;
    const jevOnPartial = vm.policySnapshot?.eso?.preflight?.jevOnPartial;

    const outcome = vm.consent?.outcome ?? 'pending';
    const waiverId = vm.consent?.waiverId;
    const decidedAt = vm.consent?.at;

    // Only draw a tick when policy actually supplied the number — a guessed band would
    // disagree with the verdict the kernel already reached.
    const ticks = [
        { key: 'T_low', value: thresholds?.T_low },
        { key: 'T_high', value: thresholds?.T_high },
    ].filter(
        (t): t is { key: string; value: number } =>
            typeof t.value === 'number' && Number.isFinite(t.value),
    );

    const inject = vm.preflight?.injectBrainBlock;

    return (
        <Panel
            className="consent-card"
            data-level={level}
            data-outcome={outcome}
            data-testid="consent-gate-card"
            aria-label="Evidence consent"
            title="Evidence & consent"
            lede="The gate that decides whether a turn with thin evidence may be submitted."
            badges={
                <>
                    <Badge tone={gateModeTone(gate)}>gate · {GATE_LABEL[gate] ?? gate}</Badge>
                    {writes ? (
                        <Badge tone={writes === 'fail_closed' ? 'danger' : 'neutral'}>
                            writes · {writes}
                        </Badge>
                    ) : null}
                    {esoMode ? <Badge tone="neutral">eso · {esoMode}</Badge> : null}
                </>
            }
            footer={
                <>
                    <span className="obs-card-flag">
                        injectBrainBlock
                        <b className={inject ? 'consent-flag--on' : undefined}>
                            {inject == null ? '—' : String(inject)}
                        </b>
                    </span>
                    {jevOnPartial != null ? (
                        <span className="obs-card-flag">
                            jevOnPartial
                            <b className={jevOnPartial ? 'consent-flag--on' : undefined}>
                                {String(jevOnPartial)}
                            </b>
                        </span>
                    ) : null}
                    {vm.preflight?.artifactPath ? (
                        <span className="obs-card-flag obs-mono">{vm.preflight.artifactPath}</span>
                    ) : null}
                </>
            }
        >
            <div className="consent-meter-row" data-testid="consent-sufficiency">
                <span className="consent-meter-label">Sufficiency</span>
                <Badge tone={sufficiencyTone(level)}>{level}</Badge>
                {scoreText ? (
                    <span className="consent-score" title={typeof score === 'number' ? String(score) : undefined}>
                        score <strong>{scoreText}</strong>
                    </span>
                ) : (
                    <span className="consent-score obs-sub">not measured</span>
                )}
            </div>

            <div className="consent-meter" data-level={level}>
                <div
                    className="consent-meter-track"
                    role="img"
                    aria-label={`Sufficiency score ${scoreText ?? 'unmeasured'}`}
                >
                    <div
                        className="consent-meter-fill"
                        style={{
                            width: hasScore && typeof score === 'number' ? toPercent(score) : '0%',
                        }}
                    />
                </div>
                {ticks.map((t) => (
                    <span
                        key={t.key}
                        className="consent-tick"
                        style={{ left: toPercent(t.value) }}
                        title={`${t.key} = ${t.value}`}
                    >
                        <span className="consent-tick-label">
                            {t.key} {t.value}
                        </span>
                    </span>
                ))}
            </div>

            {gaps.length > 0 ? (
                <div className="consent-section">
                    <h4 className="consent-section-title">
                        Gaps <span className="consent-count">{gaps.length}</span>
                    </h4>
                    <ul className="consent-gaps">
                        {gaps.map((g, i) => (
                            <li key={g.id ?? `gap-${i}`} className="consent-gap">
                                {g.kind ? <span className="chip">{g.kind}</span> : null}
                                <span className="consent-gap-text">{g.message ?? g.id ?? 'gap'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {playbook.length > 0 ? (
                <div className="consent-section" data-testid="consent-playbook">
                    <h4 className="consent-section-title">
                        Recovery playbook <span className="consent-count">{playbook.length}</span>
                    </h4>
                    <ol className="consent-playbook">
                        {playbook.map((step, i) => (
                            <li key={step.id ?? `step-${i}`} className="consent-step">
                                <span className="consent-step-n" aria-hidden="true">{i + 1}</span>
                                <span className="consent-step-text">
                                    {step.label ?? step.hint ?? step.id}
                                    {step.hint && step.hint !== step.label ? (
                                        <span className="consent-step-hint">{step.hint}</span>
                                    ) : null}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            ) : null}

            <div className="consent-choice" data-testid="consent-outcome">
                <div className="consent-choice-head">
                    <span className="consent-meter-label">Operator choice</span>
                    <Badge tone={consentOutcomeTone(outcome)} dot>
                        {OUTCOME_LABEL[outcome] ?? outcome}
                    </Badge>
                    <span className="consent-readonly">read-only</span>
                </div>
                {/* The gate is answered in the IDE, not here — this pane mirrors the recorded
                    state. Two disabled buttons read as broken; a segmented display of the two
                    possible answers, with the taken one lit, reads as the fact it is. */}
                <div className="consent-choices" aria-hidden="true">
                    {CHOICES.map((c) => (
                        <span
                            key={c}
                            className={`consent-choice-opt${outcome === c ? ' consent-choice-opt--on' : ''}`}
                        >
                            <span className="consent-choice-dot" />
                            {OUTCOME_LABEL[c]}
                        </span>
                    ))}
                </div>
                {waiverId ? (
                    <p className="consent-waiver" data-testid="consent-waiver-id">
                        Waiver <span className="obs-mono">{waiverId}</span>
                        {decidedAt ? <span className="obs-sub"> · {decidedAt}</span> : null}
                    </p>
                ) : null}
            </div>
        </Panel>
    );
}
