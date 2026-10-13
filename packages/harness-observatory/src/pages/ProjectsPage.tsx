import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
    fetchWorkspace,
    postWorkspaceAdd,
    postWorkspaceUse,
} from '@/shared/api/client';
import type { ConfigureAddResult, WorkspaceInfo } from '@/shared/api/types';
import { ErrorBanner } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

export function ProjectsPage() {
    const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [lastResult, setLastResult] = useState<ConfigureAddResult | null>(null);
    const [hint, setHint] = useState<string | null>(null);

    const [root, setRoot] = useState('');
    const [id, setId] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [port, setPort] = useState('8792');

    const reload = useCallback(async () => {
        try {
            const w = await fetchWorkspace();
            setWorkspace(w);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    async function onAdd(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setLastResult(null);
        setHint(null);
        try {
            const res = await postWorkspaceAdd({
                root: root.trim(),
                id: id.trim() || undefined,
                displayName: displayName.trim() || undefined,
                port: port.trim() ? Number.parseInt(port.trim(), 10) : undefined,
            });
            setLastResult(res);
            setError(null);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function onUse(projectId: string) {
        setBusy(true);
        setHint(null);
        try {
            const res = await postWorkspaceUse(projectId);
            await reload();
            setError(null);
            if (res.needsObserveRestart) {
                setHint('Đã chọn dự án mặc định. Trong thư mục harness-eso chạy: ./harness restart');
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    const projects = workspace?.projects ?? [];
    const defaultId = workspace?.defaultProjectId ?? null;

    return (
        <section>
            <PageHeader
                title="Projects"
                description={
                    <>
                        Provision trên <strong>Console :8791</strong> —{' '}
                        <a href="http://127.0.0.1:8791/" target="_blank" rel="noreferrer">mở Console</a>. Trang
                        này gắn observe workspace với consumer root.
                    </>
                }
            />

            {error && <ErrorBanner message={error} />}
            {hint && <p className="obs-sub">{hint}</p>}

            <Panel title="Đã liên kết">
            {projects.length === 0 ? (
                <p className="obs-sub m-0">Chưa có — thêm bên dưới (đường dẫn tuyệt đối).</p>
            ) : (
                <div className="obs-table-wrap">
                <table className="obs-table">
                    <thead>
                        <tr>
                            <th>Id</th>
                            <th>Tên</th>
                            <th>Port</th>
                            <th>Thư mục</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {projects.map((p) => (
                            <tr key={p.id} className={p.id === defaultId ? 'bg-accent/20' : undefined}>
                                <td>
                                    {p.id}
                                    {p.id === defaultId ? ' (mặc định)' : ''}
                                </td>
                                <td>{p.displayName}</td>
                                <td>{p.port}</td>
                                <td className="obs-mono">{(p as { rootHost?: string }).rootHost || p.root}</td>
                                <td>
                                    {p.id !== defaultId && (
                                        <button type="button" className="obs-btn obs-btn--ghost" disabled={busy} onClick={() => void onUse(p.id)}>
                                            Chọn mặc định
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </div>
            )}
            </Panel>

            <Panel title="Thêm dự án">
            <form className="projects-form" onSubmit={(ev) => void onAdd(ev)}>
                <label>
                    Đường dẫn repo (tuyệt đối)
                    <input
                        type="text"
                        className="obs-mono"
                        required
                        value={root}
                        onChange={(e) => setRoot(e.target.value)}
                        placeholder="/Users/you/Workspaces/x79"
                    />
                </label>
                <label>
                    Id dự án
                    <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="x79" />
                </label>
                <label>
                    Tên hiển thị
                    <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="x79"
                    />
                </label>
                <label>
                    Cổng observe
                    <input type="text" value={port} onChange={(e) => setPort(e.target.value)} />
                </label>
                <button type="submit" className="obs-btn" disabled={busy}>
                    Liên kết
                </button>
            </form>

            {lastResult?.ok && (
                <p className="obs-sub mt-3 mb-0">
                    Đã liên kết <strong>{lastResult.projectId}</strong>
                    {lastResult.created?.config ? ' · tạo harness.config.json' : ''}
                    {lastResult.created?.policy ? ' · tạo decision-policy.json' : ''}
                </p>
            )}
            </Panel>
        </section>
    );
}
