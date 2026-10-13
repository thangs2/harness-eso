export type PluginsLike = {
    jev?: { adapterId?: string; mode?: string };
};

export function jevModeFromPlugins(plugins: PluginsLike): 'off' | 'shadow' | 'active' {
    const m = plugins.jev?.mode;
    if (m === 'active' || m === 'shadow' || m === 'off') return m;
    const id = plugins.jev?.adapterId || 'off';
    if (id.includes('active')) return 'active';
    if (id.includes('shadow')) return 'shadow';
    return 'off';
}

export const JEV_SMOKE_SESSION_PREFIX = 'harness-jev-smoke-ok:';

export function jevSmokeSessionKey(projectId: string) {
    return `${JEV_SMOKE_SESSION_PREFIX}${projectId}`;
}

export function readJevSmokeOk(projectId: string | undefined): boolean {
    if (!projectId || typeof sessionStorage === 'undefined') return false;
    try {
        return sessionStorage.getItem(jevSmokeSessionKey(projectId)) === '1';
    } catch {
        return false;
    }
}

export function writeJevSmokeOk(projectId: string) {
    try {
        sessionStorage.setItem(jevSmokeSessionKey(projectId), '1');
    } catch {
        /* ignore */
    }
}
