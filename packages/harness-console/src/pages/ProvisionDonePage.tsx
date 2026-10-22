import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getProject, reloadProjectHost } from '@/api';
import { WizardSteps } from '@/WizardSteps';
import { jevModeFromPlugins, type PluginsLike } from '@/lib/jev-utils';

type Health = { ok?: boolean; startedAt?: string };

const STEPS = [
    {
        n: 1,
        title: 'Observatory Docker (harness-eso)',
        body: 'Bật Docker Desktop → trong repo harness-eso: ./deploy.sh <consumer> (hoặc ./harness up)',
    },
    {
        n: 2,
        title: 'Console init consumer (bạn vừa làm)',
        body: 'Provision x79: harness.config.json + hooks trên repo agent.',
    },
    {
        n: 3,
        title: 'Agent + kiểm tra',
        body: 'Reload Cursor (x79) → prompt thử → mở Observatory :8792 (Requests / evidence).',
    },
];

const POLL_MS = 3000;

export function ProvisionDonePage() {
    const { id } = useParams();
    const [params] = useSearchParams();
    const observePort = Number.parseInt(params.get('port') || '8792', 10) || 8792;
    const observeUrl = params.get('observe') || `http://127.0.0.1:${observePort}`;
    const [health, setHealth] = useState<Health | null>(null);
    const [pollError, setPollError] = useState<string | null>(null);
    const [jevMode, setJevMode] = useState<'off' | 'shadow' | 'active'>('off');
    const [reloadMsg, setReloadMsg] = useState<string | null>(null);

    useEffect(() => {
        if (!id) return;
        void getProject(id)
            .then((r) => setJevMode(jevModeFromPlugins(r.project.plugins as PluginsLike)))
            .catch(() => setJevMode('off'));
    }, [id]);

    const checkHealth = useCallback(async () => {
        if (!id) return false;
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}/observe-health`, {
            headers: { Accept: 'application/json' },
        });
        let body: Health & { hint?: string; message?: string } = {};
        try {
            body = (await res.json()) as Health & { hint?: string; message?: string };
        } catch {
            /* ignore */
        }
        if (res.ok && body.ok) {
            setHealth(body);
            setPollError(null);
            return true;
        }
        setPollError(body.hint || body.message || `HTTP ${res.status}`);
        return false;
    }, [id]);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        async function loop() {
            if (cancelled) return;
            const ok = await checkHealth();
            if (cancelled || ok) return;
            timer = setTimeout(() => void loop(), POLL_MS);
        }

        void loop();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [checkHealth]);

    const step1Ok = Boolean(health?.ok);

    return (
        <div>
            <WizardSteps current="done" />
            <h2>Bước 2 hoàn tất — init consumer</h2>
            <p className="sub m-0 mb-4">
                Luồng cố định: <strong>1 Docker observe</strong> → <strong>2 Console init</strong> →{' '}
                <strong>3 prompt + Observatory</strong>. Health bên dưới chỉ phản ánh <strong>bước 1</strong>.
            </p>

            <ol className="text-sm space-y-3 pl-5 m-0 mb-4">
                {STEPS.map((s) => (
                    <li key={s.n}>
                        <strong>
                            {s.n}. {s.title}
                        </strong>
                        {s.n === 1 && step1Ok ? (
                            <span className="text-green-300"> — OK</span>
                        ) : null}
                        {s.n === 2 ? <span className="text-green-300"> — OK (provision)</span> : null}
                        <div className="sub text-xs mt-1">{s.body}</div>
                    </li>
                ))}
            </ol>

            <section className="card">
                <h3 className="text-base m-0 mb-2">Bước 1 — /health (Observatory)</h3>
                {step1Ok ? (
                    <p className="text-sm text-green-300 m-0">
                        OK — {observeUrl} (started {health?.startedAt ?? '—'}). Tiếp bước 3.
                    </p>
                ) : (
                    <p className="sub m-0">
                        Chưa sẵn sàng: {pollError ?? 'đang kiểm tra…'} (poll {POLL_MS / 1000}s, tự cập nhật sau khi
                        bạn chạy bước 1).
                    </p>
                )}
            </section>

            {jevMode !== 'off' && (
                <p className="sub text-xs mt-4 mb-0">
                    Jev <code>{jevMode}</code>: consumer{' '}
                    <code>installation/typesafe/README.md</code> + smoke-jev trước prompt nặng.
                </p>
            )}

            <div className="flex flex-wrap gap-2 mt-4">
                <a className="btn-link" href={observeUrl} target="_blank" rel="noreferrer">
                    Mở Observatory
                </a>
                <Link to="/">← Danh sách dự án</Link>
                {id && (
                    <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                            void reloadProjectHost(id, { tenant: true })
                                .then((r) =>
                                    setReloadMsg(
                                        `Đã ghi lại host + tenant config (${r.hostProfileIds.join(', ')}) — appliedAt ${r.bootstrap?.appliedAt ?? '—'}. Reload Cursor để hooks.json mới có hiệu lực.`,
                                    ),
                                )
                                .catch((err) => setReloadMsg(`Lỗi: ${(err as Error).message}`))
                        }
                    >
                        Ghi lại tenant config
                    </button>
                )}
                {id && <Link to={`/projects/${id}/config`}>Sửa cấu hình</Link>}
            </div>
            {reloadMsg && <p className="sub text-xs mt-2 mb-0">{reloadMsg}</p>}
        </div>
    );
}
