import { Link, useParams } from 'react-router-dom';

const STEPS = [
    { key: 'config', label: 'Cấu hình', path: (id: string) => `/projects/${id}/config` },
    { key: 'plugins', label: 'Tích hợp', path: (id: string) => `/projects/${id}/plugins` },
    { key: 'preview', label: 'Xem trước', path: (id: string) => `/projects/${id}/preview` },
    { key: 'done', label: 'Hoàn tất', path: (id: string) => `/projects/${id}/done` },
];

export function WizardSteps({ current }: { current: string }) {
    const { id } = useParams();
    if (!id) return null;
    return (
        <nav className="steps" aria-label="Wizard">
            {STEPS.map((s) => (
                <Link key={s.key} to={s.path(id)} className={current === s.key ? 'on' : undefined}>
                    {s.label}
                </Link>
            ))}
        </nav>
    );
}
