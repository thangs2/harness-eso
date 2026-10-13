import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createProject, listProjects, type HarnessProject, type HostPackSummary } from '@/api';

/**
 * Host pack health badge.
 *
 * The states are not cosmetic: `broken` and `missing` mean the consumer's guards are not deciding
 * anything, and because guards fail closed that shows up in the IDE as an unexplained inability to
 * run commands. Surfacing it on the project list is the difference between a five-minute diagnosis
 * and an afternoon one.
 */
function HostPackBadge({ pack }: { pack?: HostPackSummary | null }) {
    if (!pack) return null;
    const label: Record<HostPackSummary['state'], string> = {
        ok: 'pack ok',
        outdated: 'pack outdated',
        unwired: 'pack unwired',
        missing: 'pack missing',
        broken: 'pack broken',
        error: 'pack ?',
    };
    const suffix = pack.version && pack.state === 'ok' ? ` ${pack.version}` : '';
    return (
        <span className={`badge badge--${pack.state}`} title={pack.detail ?? ''}>
            {label[pack.state]}
            {suffix}
        </span>
    );
}

export function HomePage() {
    const [items, setItems] = useState<HarnessProject[]>([]);
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const nav = useNavigate();

    useEffect(() => {
        void listProjects()
            .then((r) => setItems(r.items))
            .catch((e) => setError((e as Error).message));
    }, []);

    async function onCreate(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const { project } = await createProject(name.trim());
            nav(`/projects/${project.id}/config`);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div>
            <p className="sub">
                Quản lý dự án Harness (tách khỏi Observatory :8792). Cổng Console: <strong>8791</strong>.
            </p>

            <div className="card">
                <h2>Tạo dự án mới</h2>
                <form onSubmit={(e) => void onCreate(e)}>
                    <label>
                        Tên dự án (vd. x79, baplatform)
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="x79"
                            required
                        />
                    </label>
                    <button type="submit" disabled={busy}>Create new project</button>
                </form>
                {error && <p className="error">{error}</p>}
            </div>

            <h2>Dự án</h2>
            {items.length === 0 ? (
                <p className="sub">Chưa có dự án.</p>
            ) : (
                <ul className="list">
                    {items.map((p) => (
                        <li key={p.id}>
                            <span>
                                <strong>{p.id}</strong>
                                {p.displayName !== p.id ? ` — ${p.displayName}` : ''} · {p.status}{' '}
                                <HostPackBadge pack={p.hostPack} />
                            </span>
                            <Link to={`/projects/${p.id}/config`}>Mở</Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
