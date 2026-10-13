export function LoadingState({ label = 'Loading…' }: { label?: string }) {
    return <p className="obs-sub" role="status">{label}</p>;
}

export function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="obs-error" role="alert">
            {message}
        </div>
    );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
    return (
        <div className="obs-empty">
            <p className="text-base text-slate-200 m-0 mb-2">{title}</p>
            {hint && <p className="m-0">{hint}</p>}
        </div>
    );
}
