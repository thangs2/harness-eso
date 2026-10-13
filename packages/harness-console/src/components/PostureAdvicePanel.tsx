type PluginsLike = {
    jev?: { adapterId?: string; mode?: string };
    law?: { adapterId?: string };
    code?: { adapterId?: string };
    memory?: { adapterId?: string };
};

function jevMode(plugins: PluginsLike) {
    const m = plugins.jev?.mode;
    if (m && m !== 'off') return m;
    const id = plugins.jev?.adapterId || 'off';
    if (id.includes('active')) return 'active';
    if (id.includes('shadow')) return 'shadow';
    return 'off';
}

export function PostureAdvicePanel({ plugins }: { plugins: PluginsLike }) {
    const mode = jevMode(plugins);
    const failClosedRecommended = mode === 'active';
    const esoMode = failClosedRecommended ? 'hint → fail_closed khi sẵn sàng' : 'observe (mặc định an toàn)';
    const enforce = failClosedRecommended ? 'fail_closed' : 'off';

    return (
        <aside className="callout callout--info" aria-label="Policy posture advice">
            <h3 className="text-sm font-semibold m-0 mb-2">Gợi ý posture ESO</h3>
            <ul className="text-sm space-y-1 m-0 pl-4 list-disc opacity-90">
                <li>
                    <code>eso.mode</code>: <strong>{esoMode}</strong> — observe không chặn ghi;{' '}
                    <code>fail_closed</code> chỉ khi operator chấp nhận rủi ro false block.
                </li>
                <li>
                    <code>eso.enforceWrites</code>: khuyến nghị <strong>{enforce}</strong> khi Jev{' '}
                    {mode === 'active' ? 'active' : 'off/shadow'}.
                </li>
                <li>
                    <code>eso.preflight.enabled</code>: <strong>true</strong> sau provision (sidecar :8792).
                </li>
                <li>
                    Fail-open: gate chỉ ghi nhận · Fail-closed: insufficient → chặn protected write (
                    <code>guard-write</code>).
                </li>
            </ul>
            <p className="sub mt-2 mb-0 text-xs">
                Chỉ gợi ý — giá trị thật nằm trong <code>.harness/decision-policy.json</code> khi provision.
            </p>
        </aside>
    );
}
