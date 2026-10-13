import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getProject, previewProject, provisionProject } from '@/api';
import { WizardSteps } from '@/WizardSteps';
import { JevKeyAdvice } from '@/components/JevKeyAdvice';
import { jevModeFromPlugins, readJevSmokeOk, type PluginsLike } from '@/lib/jev-utils';

type PreviewFile = {
    relative: string;
    action: string;
    exists: boolean;
    preview: unknown;
    group?: 'tenant' | 'cursor' | 'agents';
};

const GROUP_LABEL: Record<string, string> = {
    tenant: 'Tenant / .harness',
    cursor: 'Cursor (.cursor)',
    agents: 'Antigravity (.agents)',
};

function inferGroup(relative: string): PreviewFile['group'] {
    if (relative.startsWith('.cursor/')) return 'cursor';
    if (relative.startsWith('.agents/')) return 'agents';
    return 'tenant';
}

function actionBadge(action: string) {
    if (action === 'merge') return 'merge';
    if (action === 'skip') return 'skip (exists)';
    if (action === 'create-if-missing') return 'create-if-missing';
    if (action === 'runtime') return 'runtime (hook)';
    return action;
}

export function PreviewPage() {
    const { id } = useParams();
    const nav = useNavigate();
    const [files, setFiles] = useState<PreviewFile[]>([]);
    const [root, setRoot] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [plugins, setPlugins] = useState<PluginsLike | null>(null);
    const [consumerRoot, setConsumerRoot] = useState('');
    const [jevSmokeOk, setJevSmokeOk] = useState(false);
    const [jevSkipAck, setJevSkipAck] = useState(false);

    const jevMode = plugins ? jevModeFromPlugins(plugins) : 'off';
    const jevActiveNeedsGate = jevMode === 'active' && !jevSmokeOk && !jevSkipAck;

    useEffect(() => {
        if (!id) return;
        setJevSmokeOk(readJevSmokeOk(id));
        void getProject(id)
            .then((r) => {
                setPlugins(r.project.plugins as PluginsLike);
                setConsumerRoot(r.project.agentRepo?.root || '');
            })
            .catch((e) => setError((e as Error).message));
        void previewProject(id)
            .then((r) => {
                setFiles(
                    r.files.map((f) => ({
                        ...f,
                        group: f.group ?? inferGroup(f.relative),
                    })),
                );
                setRoot(r.root);
            })
            .catch((e) => setError((e as Error).message));
    }, [id]);

    const grouped = useMemo(() => {
        const order = ['tenant', 'cursor', 'agents'] as const;
        const map = new Map<string, PreviewFile[]>();
        for (const g of order) map.set(g, []);
        for (const f of files) {
            const g = f.group ?? inferGroup(f.relative) ?? 'tenant';
            map.get(g)?.push(f);
        }
        return order.map((g) => ({ id: g, label: GROUP_LABEL[g], items: map.get(g) ?? [] }));
    }, [files]);

    async function onProvision() {
        if (!id) return;
        setBusy(true);
        setError(null);
        try {
            const r = await provisionProject(id);
            setDone(`Khởi tạo xong. Monitor: ${r.observeUrl}`);
            const port = new URL(r.observeUrl).port || '8792';
            nav(`/projects/${id}/done?observe=${encodeURIComponent(r.observeUrl)}&port=${port}`);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    const writableCount = files.filter((f) => f.action !== 'runtime').length;

    return (
        <div>
            <WizardSteps current="preview" />
            <h2>Xem trước & khởi tạo</h2>
            <p className="sub">
                Root: <code>{root || '—'}</code>
            </p>

            {plugins && jevMode !== 'off' && (
                <JevKeyAdvice
                    plugins={plugins}
                    projectId={id}
                    consumerRoot={consumerRoot || undefined}
                    compact
                    onSmokeOkChange={(ok) => setJevSmokeOk(ok)}
                />
            )}

            {jevMode === 'active' && !jevSmokeOk && (
                <label className="sub callout callout--warn" style={{ display: 'block', margin: '1rem 0' }}>
                    <input
                        type="checkbox"
                        checked={jevSkipAck}
                        onChange={(e) => setJevSkipAck(e.target.checked)}
                    />
                    {' '}
                    Tôi sẽ cấu hình <code>TYPESAFE_API_KEY</code> trên consumer sau provision (bỏ qua test ngay
                    bây giờ).
                </label>
            )}

            {grouped.map((section) =>
                section.items.length ? (
                    <section key={section.id} className="card" style={{ marginBottom: '1rem' }}>
                        <h3>{section.label}</h3>
                        {section.items.map((f) => (
                            <div key={f.relative} style={{ marginBottom: '0.75rem' }}>
                                <strong>{f.relative}</strong>
                                <span className="sub">
                                    {' '}
                                    — <code>{actionBadge(f.action)}</code>
                                    {f.exists && f.action === 'create-if-missing'
                                        ? ' (đã tồn tại → bỏ qua)'
                                        : ''}
                                    {f.action === 'merge' ? ' (gộp hook, giữ entry hiện có)' : ''}
                                </span>
                                {f.action !== 'runtime' ? (
                                    <pre>{JSON.stringify(f.preview, null, 2)}</pre>
                                ) : (
                                    <p className="sub">{String((f.preview as { note?: string })?.note ?? '')}</p>
                                )}
                            </div>
                        ))}
                    </section>
                ) : null,
            )}

            <label className="sub" style={{ display: 'block', margin: '1rem 0' }}>
                <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                />
                {' '}
                Tôi đã xem danh sách file (tenant + IDE host pack) và chấp nhận ghi/merge trên consumer.
            </label>

            <button
                type="button"
                disabled={busy || !writableCount || !confirmed || jevActiveNeedsGate}
                onClick={() => void onProvision()}
            >
                Khởi tạo
            </button>
            {jevActiveNeedsGate && (
                <p className="error text-sm">
                    Jev <code>active</code>: chạy &quot;Test kết nối Jev&quot; hoặc tick bỏ qua ở trên trước khi
                    provision.
                </p>
            )}
            {done && <p className="sub">{done}</p>}
            {error && <p className="error">{error}</p>}
            <p className="sub">
                Sau khởi tạo: reload IDE → gửi prompt → kiểm tra{' '}
                <code>.cursor/session/.eso-preflight.json</code> (dual-ide: cả <code>.agents/session/</code>) khi
                observe đang chạy.
            </p>
            <p className="sub">
                Sau khởi tạo: <code>./harness up</code> rồi mở Observatory {done ? '' : '(8792)'}.
            </p>
            <Link to="/">← Danh sách dự án</Link>
        </div>
    );
}
