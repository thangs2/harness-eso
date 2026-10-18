import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConsentGateCard, shouldShowConsentCard } from '@/features/consent/ConsentGateCard';
import { RequestDetailHeader } from '@/features/requests/RequestDetailHeader';
import { PipelineStepper, type PipelineStageId } from '@/features/requests/PipelineStepper';
import { EndToEndFlowDiagram } from '@/features/requests/EndToEndFlowDiagram';
import { RequestDrillBlocks, type DrillTabKey } from '@/features/requests/RequestDrillBlocks';
import { TokensBlock } from '@/features/requests/TokensBlock';
import { fetchRequestDetail } from '@/shared/api/client';
import type { RequestDetailResponse } from '@/shared/api/types';
import { ErrorBanner, LoadingState } from '@/ui/Feedback';

export function RequestDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [detail, setDetail] = useState<RequestDetailResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<DrillTabKey>('waterfall');

    const load = useCallback(() => {
        if (!id) return;
        setLoading(true);
        fetchRequestDetail(id)
            .then((res) => {
                setDetail(res);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    const handleSelectStage = (_stageId: PipelineStageId, recommendedTab: string) => {
        setActiveTab(recommendedTab as DrillTabKey);
    };

    if (!id) return <p className="obs-sub">Missing request id.</p>;
    if (loading && !detail) return <LoadingState label={`Loading turn ${id}…`} />;
    if (error) return <ErrorBanner message={`Could not load request: ${error}`} />;
    if (!detail) return null;

    return (
        <section className="request-detail-page space-y-4">
            <RequestDetailHeader detail={detail} id={id} />

            {/* Pipeline Stage Stepper — 8-stage subway map navigation */}
            <PipelineStepper
                detail={detail}
                activeTab={activeTab}
                onSelectStage={handleSelectStage}
            />

            {/* End-to-End Pipeline Data Flow Chart Diagram */}
            <EndToEndFlowDiagram detail={detail} />

            {/* The gate and the cost read are the two "at a glance" answers for a turn, so they
                share a row. When the gate reports nothing, Tokens takes the full width rather
                than leaving a dead half-column. */}
            <div className={`detail-top-grid${shouldShowConsentCard(detail) ? '' : ' detail-top-grid--single'}`}>
                <ConsentGateCard
                    eso={detail.eso}
                    consent={detail.consent}
                    preflight={detail.preflight}
                    policySnapshot={detail.policySnapshot}
                />
                <TokensBlock detail={detail} />
            </div>

            <RequestDrillBlocks
                detail={detail}
                activeTab={activeTab}
                onTabChange={setActiveTab}
            />
        </section>
    );
}
