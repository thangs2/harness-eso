import { useCallback, useEffect, useState } from 'react';
import {
    fetchApiVersion,
    fetchHealth,
    fetchIngestStatus,
    fetchProject,
    fetchToggleState,
    postIngestRun,
    postToggle,
} from '@/shared/api/client';
import type { ApiVersion, HealthResponse, IngestStatus, ProjectInfo } from '@/shared/api/types';
import { subscribeObserveRefresh } from '@/shared/events/observeRefresh';
import { ErrorBanner } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

export function StatusPage() {
    const [version, setVersion] = useState<ApiVersion | null>(null);
    const [project, setProject] = useState<ProjectInfo | null>(null);
    const [health, setHealth] = useState<HealthResponse | null>(null);
    const [ingest, setIngest] = useState<IngestStatus | null>(null);
    const [tracking, setTracking] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastAction, setLastAction] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const [v, t, h, i, tg] = await Promise.all([
                fetchApiVersion(),
                fetchProject(),
                fetchHealth(),
                fetchIngestStatus(),
                fetchToggleState(),
            ]);
            setVersion(v);
            setProject(t);
            setHealth(h);
            setIngest(i);
            setTracking(tg.enabled);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        void reload();
        return subscribeObserveRefresh(() => {
            void reload();
        });
    }, [reload]);

    async function onToggle() {
        if (tracking == null) return;
        setBusy(true);
        try {
            const res = await postToggle(!tracking);
            setTracking(res.enabled);
            setLastAction(`Tracking ${res.enabled ? 'enabled' : 'disabled'}`);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function onIngest() {
        setBusy(true);
        try {
            const report = await postIngestRun();
            setLastAction(report.ok ? 'Ingest cycle finished' : `Ingest failed: ${report.reason ?? 'unknown'}`);
            await reload();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section>
            <PageHeader
                title="Status"
                description="Ingest health, tracer sentinel, manual ingest for debugging."
            />
            {error && <ErrorBanner message={error} />}
            {ingest?.spineOk === false && ingest.warnings?.map((w) => <ErrorBanner key={w} message={w} />)}
            {lastAction && <p className="obs-sub">{lastAction}</p>}

            <Panel title="Runtime">
                <dl className="obs-kv">
                    <dt>API</dt>
                    <dd>
                        {version
                            ? `${version.package} v${version.serverVersion} (contract ${version.apiVersion})`
                            : '…'}
                    </dd>
                    <dt>Project</dt>
                    <dd>{project ? `${project.displayName} (${project.id})` : '…'}</dd>
                    <dt>Root</dt>
                    <dd className="obs-mono">{project?.rootPath ?? '—'}</dd>
                    <dt>Server</dt>
                    <dd className="obs-mono">{project?.server?.url ?? '—'}</dd>
                    <dt>Health</dt>
                    <dd>
                        {health
                            ? `ok=${health.ok} · revision ${health.revision ?? 0} · turns ${health.turns ?? 0}`
                            : '…'}
                    </dd>
                    <dt>Ingest DB</dt>
                    <dd className="obs-mono">{ingest?.db ?? '—'}</dd>
                    <dt>Counts</dt>
                    <dd>
                        {ingest?.counts
                            ? `requests ${ingest.counts.requests} · calls ${ingest.counts.calls} · events ${ingest.counts.events}`
                            : '—'}
                    </dd>
                    <dt>Transcript dir</dt>
                    <dd className="obs-mono">
                        {ingest?.transcriptDir ?? '—'}
                        {ingest?.transcriptDirExists === false && (ingest?.transcriptFiles ?? 0) === 0
                            ? ' (waiting for sessions)'
                            : ''}
                        {ingest?.transcriptFiles != null
                            ? ` · ${ingest.transcriptFiles} file(s) discovered`
                            : ''}
                    </dd>
                    <dt>Tracking</dt>
                    <dd>{tracking == null ? '…' : tracking ? 'enabled' : 'disabled (sentinel)'}</dd>
                </dl>

                <div className="flex flex-wrap gap-2 mt-4">
                    <button type="button" className="obs-btn" disabled={busy || tracking == null} onClick={() => void onToggle()}>
                        {tracking ? 'Disable tracer' : 'Enable tracer'}
                    </button>
                    <button type="button" className="obs-btn obs-btn--ghost" disabled={busy} onClick={() => void onIngest()}>
                        Run ingest now
                    </button>
                </div>
            </Panel>
        </section>
    );
}
