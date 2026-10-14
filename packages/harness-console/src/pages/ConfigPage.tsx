import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    fetchHostProfiles,
    fetchMeta,
    getProject,
    patchProject,
    reloadProjectHost,
    type HostProfileSummary,
} from '@/api';
import { WizardSteps } from '@/WizardSteps';
import { ConsentManagementPanel } from '@/components/ConsentManagementPanel';

export function ConfigPage() {
    const { id } = useParams();
    const nav = useNavigate();
    const [displayName, setDisplayName] = useState('');
    const [root, setRoot] = useState('');
    const [port, setPort] = useState('8792');
    const [hostMode, setHostMode] = useState<'dual-ide' | 'superset'>('dual-ide');
    const [hostProfile, setHostProfile] = useState('cursor-superset');
    const [hostProfiles, setHostProfiles] = useState<HostProfileSummary[]>([]);
    const [agentRootDefault, setAgentRootDefault] = useState<string>('');
    const [reloadMsg, setReloadMsg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void fetchMeta()
            .then((m) => setAgentRootDefault(m.agentRootDefault || ''))
            .catch(() => setAgentRootDefault(''));
        void fetchHostProfiles()
            .then((r) => setHostProfiles(r.items))
            .catch(() => {
                setHostProfiles([
                    {
                        id: 'cursor-superset',
                        label: 'Cursor',
                        trees: ['cursor'],
                        supersetFor: 'cursor',
                    },
                    {
                        id: 'agents-superset',
                        label: 'Antigravity',
                        trees: ['agents'],
                        supersetFor: 'agents',
                    },
                ]);
            });
    }, []);

    useEffect(() => {
        if (!id) return;
        void getProject(id).then((r) => {
            setDisplayName(r.project.displayName);
            setRoot(r.project.agentRepo?.root || '');
            setPort(String(r.project.observe?.port || 8792));
            setHostMode((r.project.hostMode as 'dual-ide' | 'superset') || 'dual-ide');
            setHostProfile(r.project.hostProfile || 'cursor-superset');
        });
    }, [id]);

    async function onSave(e: FormEvent) {
        e.preventDefault();
        if (!id) return;
        setError(null);
        try {
            await patchProject(id, {
                displayName,
                agentRepo: { root },
                observe: { port: Number.parseInt(port, 10) || 8792 },
                hostMode,
                hostProfile: hostMode === 'superset' ? hostProfile : undefined,
            });
            nav(`/projects/${id}/plugins`);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return (
        <div>
            <WizardSteps current="config" />
            <h2>Cấu hình · {id}</h2>
            <form onSubmit={(e) => void onSave(e)}>
                <label>
                    Tên hiển thị
                    <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                </label>
                <label>
                    Root repo agent (tuyệt đối)
                    <input
                        value={root}
                        onChange={(e) => setRoot(e.target.value)}
                        placeholder={agentRootDefault ? `${agentRootDefault}/x79` : '/Users/you/Workspaces/x79'}
                        required
                    />
                    <span className="sub text-xs">
                        Repo consumer phải nằm ngoài harness-eso.
                        {agentRootDefault ? ` Workspace agent: ${agentRootDefault}` : ''}
                    </span>
                </label>
                <label>
                    Cổng observe (monitor)
                    <input value={port} onChange={(e) => setPort(e.target.value)} />
                </label>
                <fieldset>
                    <legend>Host pack (full ≥ Promax)</legend>
                    <label>
                        <input
                            type="radio"
                            name="hostMode"
                            checked={hostMode === 'dual-ide'}
                            onChange={() => setHostMode('dual-ide')}
                        />
                        Dual-IDE — Cursor + Antigravity (khuyến nghị x79)
                    </label>
                    <label>
                        <input
                            type="radio"
                            name="hostMode"
                            checked={hostMode === 'superset'}
                            onChange={() => setHostMode('superset')}
                        />
                        Superset — một IDE
                    </label>
                    {hostMode === 'superset' && (
                        <label>
                            IDE
                            <select value={hostProfile} onChange={(e) => setHostProfile(e.target.value)}>
                                {hostProfiles
                                    .filter((p) => p.trees.length === 1)
                                    .map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                            {p.supersetFor === 'agents' ? ' (.agents)' : ''}
                                        </option>
                                    ))}
                            </select>
                        </label>
                    )}
                </fieldset>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button type="submit">Tiếp — Tích hợp</button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={!id}
                        onClick={() => {
                            if (!id) return;
                            void reloadProjectHost(id)
                                .then((r) =>
                                    setReloadMsg(
                                        `Đã ghi lại host config (${r.hostProfileIds.join(', ')}) — ${r.files.length} file.`,
                                    ),
                                )
                                .catch((err) => setReloadMsg(`Lỗi: ${(err as Error).message}`));
                        }}
                    >
                        Reload host config
                    </button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={!id}
                        onClick={() => {
                            if (!id) return;
                            void reloadProjectHost(id, { tenant: true })
                                .then((r) =>
                                    setReloadMsg(
                                        `Đã ghi lại host + tenant (${r.hostProfileIds.join(', ')}) — ${r.files.length} file.`,
                                    ),
                                )
                                .catch((err) => setReloadMsg(`Lỗi: ${(err as Error).message}`));
                        }}
                    >
                        Ghi lại tenant config
                    </button>
                    <Link to="/" className="secondary">
                        <button type="button" className="secondary">Hủy</button>
                    </Link>
                </div>
            </form>
            {reloadMsg && <p className="sub">{reloadMsg}</p>}
            {error && <p className="error">{error}</p>}

            {id && <ConsentManagementPanel projectId={id} />}
        </div>
    );
}
