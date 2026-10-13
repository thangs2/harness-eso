import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConsentGateCard, shouldShowConsentCard } from '@/features/consent/ConsentGateCard';
import { RequestDetailHeader } from '@/features/requests/RequestDetailHeader';
import { RequestDrillBlocks } from '@/features/requests/RequestDrillBlocks';
import { TokensBlock } from '@/features/requests/TokensBlock';
import { fetchRequestDetail } from '@/shared/api/client';
import type { RequestDetailResponse } from '@/shared/api/types';
import { ErrorBanner, LoadingState } from '@/ui/Feedback';

export function RequestDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [detail, setDetail] = useState<RequestDetailResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

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

    if (!id) return <p className="obs-sub">Missing request id.</p>;
    if (loading && !detail) return <LoadingState label={`Loading turn ${id}…`} />;
    if (error) return <ErrorBanner message={`Could not load request: ${error}`} />;
    if (!detail) return null;

    return (
        <section className="request-detail-page">
            <RequestDetailHeader detail={detail} id={id} />

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

            <RequestDrillBlocks detail={detail} />
        </section>
    );
}
