import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { NAV_TABS } from './navTabs';
import { fetchHealth, fetchTenant } from '@/shared/api/client';
import { ErrorBanner } from '@/ui/Feedback';
import { connectObserveSse } from '@/shared/events/observeRefresh';

export function ShellLayout() {
    const [tenantLabel, setTenantLabel] = useState<string | null>(null);
    const [healthOk, setHealthOk] = useState<boolean | null>(null);
    const [turns, setTurns] = useState<number | null>(null);
    const [spineWarnings, setSpineWarnings] = useState<string[]>([]);
    const headerRef = useRef<HTMLElement | null>(null);

    /**
     * Publish the real header height so sticky table heads can offset by it.
     * The nav wraps onto a second line at narrow widths, so the height is measured rather
     * than assumed — a hardcoded value silently drifted (52px declared vs 107px actual) and
     * the sticky thead slid out of sight under the header.
     */
    useEffect(() => {
        const el = headerRef.current;
        if (!el) return;
        const publish = () => {
            const h = Math.round(el.getBoundingClientRect().height);
            if (h > 0) document.documentElement.style.setProperty('--obs-header-h', `${h}px`);
        };
        publish();
        const ro = new ResizeObserver(publish);
        ro.observe(el);
        return () => {
            ro.disconnect();
            document.documentElement.style.removeProperty('--obs-header-h');
        };
    }, []);

    useEffect(() => {
        const stopSse = connectObserveSse();
        const pollHealth = () => {
            fetchHealth()
                .then((h) => {
                    setHealthOk(Boolean(h.ok) && !h.degraded);
                    setTurns(h.turns ?? null);
                    setSpineWarnings(h.ingestSpine?.warnings ?? []);
                })
                .catch(() => setHealthOk(false));
        };
        pollHealth();
        fetchTenant()
            .then((t) => setTenantLabel(`${t.displayName} · ${t.id}`))
            .catch(() => setTenantLabel(null));
        const id = window.setInterval(pollHealth, 15000);
        return () => {
            stopSse();
            window.clearInterval(id);
        };
    }, []);

    return (
        <div className="obs-shell">
            <header className="obs-header" ref={headerRef}>
                <div className="obs-header-inner">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h1 className="text-base font-semibold m-0">Harness Observatory</h1>
                            <p className="obs-sub m-0 text-xs">
                                Read-only audit · {typeof window !== 'undefined' && window.location.port ? `port ${window.location.port}` : 'port 8792'}
                                {tenantLabel ? ` · ${tenantLabel}` : ''}
                            </p>
                        </div>
                        <div
                            className="obs-health"
                            title={healthOk ? 'Observe API healthy' : 'Cannot reach /health'}
                        >
                            <span
                                className={`obs-health-dot ${healthOk ? 'obs-health-dot--ok' : healthOk === false ? 'obs-health-dot--bad' : ''}`}
                            />
                            {healthOk ? (
                                <span>
                                    Live{turns != null ? ` · ${turns} turns` : ''}
                                </span>
                            ) : healthOk === false ? (
                                <span>Offline</span>
                            ) : (
                                <span>…</span>
                            )}
                        </div>
                    </div>
                    <nav className="obs-nav" aria-label="Primary">
                        {NAV_TABS.map((tab) => (
                            <NavLink key={tab.path} to={tab.path} end={tab.path === '/requests'}>
                                {tab.label}
                            </NavLink>
                        ))}
                    </nav>
                </div>
            </header>
            <main className="obs-main">
                {spineWarnings.length > 0 && (
                    <ErrorBanner
                        message={`${spineWarnings[0]}${spineWarnings.length > 1 ? ` (+${spineWarnings.length - 1} more — see Status)` : ''}`}
                    />
                )}
                <Outlet />
            </main>
        </div>
    );
}
