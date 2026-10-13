import { useCallback, useEffect, useState } from 'react';
import { fetchJevStatus, smokeTestJev } from '@/api';
import { jevModeFromPlugins, type PluginsLike, writeJevSmokeOk } from '@/lib/jev-utils';

const ENV_FILE = 'installation/typesafe/typesafe.env';
const ENV_VAR = 'TYPESAFE_API_KEY';
const TYPESAFE_KEYS_URL = 'https://console.typesafe.ai/keys';

type Props = {
    plugins: PluginsLike;
    projectId?: string;
    consumerRoot?: string;
    /** When true, show compact layout (e.g. preview step). */
    compact?: boolean;
    onSmokeOkChange?: (ok: boolean) => void;
};

export function JevKeyAdvice({
    plugins,
    projectId,
    consumerRoot,
    compact,
    onSmokeOkChange,
}: Props) {
    const mode = jevModeFromPlugins(plugins);
    const [status, setStatus] = useState<{
        serverEnvKey: boolean;
        consumer: { envFileExists: boolean; keyConfigured: boolean; envPath?: string };
        ready: boolean;
    } | null>(null);
    const [pasteKey, setPasteKey] = useState('');
    const [testing, setTesting] = useState(false);
    const [testMsg, setTestMsg] = useState<string | null>(null);
    const [smokeOk, setSmokeOk] = useState(false);

    useEffect(() => {
        if (mode === 'off') return;
        let cancelled = false;
        void fetchJevStatus(consumerRoot)
            .then((s) => {
                if (!cancelled) {
                    setStatus(s);
                    if (s.ready) {
                        setSmokeOk(true);
                        if (onSmokeOkChange) onSmokeOkChange(true);
                    }
                }
            })
            .catch(() => {
                if (!cancelled) setStatus(null);
            });
        return () => {
            cancelled = true;
        };
    }, [mode, consumerRoot]);

    const runSmoke = useCallback(async () => {
        setTesting(true);
        setTestMsg(null);
        try {
            const r = await smokeTestJev(pasteKey.trim() ? { apiKey: pasteKey.trim() } : {});
            if (r.ok) {
                setSmokeOk(true);
                if (projectId) writeJevSmokeOk(projectId);
                onSmokeOkChange?.(true);
                setTestMsg('Kết nối TypeSafe OK — key không được lưu trên Console.');
                setPasteKey('');
            } else {
                setTestMsg(r.message || r.error || 'Smoke thất bại');
            }
        } catch (e) {
            setTestMsg((e as Error).message);
        } finally {
            setTesting(false);
        }
    }, [pasteKey, projectId, onSmokeOkChange]);

    if (mode === 'off') return null;

    const needsKey = mode === 'active';
    const ready = smokeOk || status?.ready;

    return (
        <section className={`card jev-advice ${compact ? 'jev-advice--compact' : ''}`} aria-labelledby="jev-advice-title">
            <h3 id="jev-advice-title" className="text-base m-0 mb-2">
                TypeSafe / Jev — <code>{mode}</code>
            </h3>

            {needsKey && !ready && (
                <p className="callout callout--warn m-0 mb-3">
                    <strong>Active</strong> cần API key trên máy chạy agent (IDE hooks / shell guard). Console{' '}
                    <em>không</em> lưu secret — chỉ policy <code>jev.mode</code> khi provision.
                </p>
            )}

            <ol className="text-sm space-y-2 pl-5 m-0 mb-3">
                <li>
                    Lấy key:{' '}
                    <a href={TYPESAFE_KEYS_URL} target="_blank" rel="noreferrer">
                        console.typesafe.ai/keys
                    </a>
                </li>
                <li>
                    Trên repo consumer:{' '}
                    <code>cp installation/typesafe/typesafe.env.example {ENV_FILE}</code>
                </li>
                <li>
                    Gán <code>{ENV_VAR}</code> trong <code>{ENV_FILE}</code> (hoặc export shell).
                </li>
                <li>
                    Smoke: <code>source installation/typesafe/export-env.sh</code> →{' '}
                    <code>bun run installation/typesafe/smoke-jev.mjs</code>
                </li>
                <li>Reload IDE / terminal sau khi có key (Cursor cần env trong session agent).</li>
            </ol>

            {status && (
                <ul className="text-xs sub m-0 mb-3 list-none p-0 space-y-1">
                    <li>
                        Console server env: {status.serverEnvKey ? 'có TYPESAFE_API_KEY' : 'chưa có'}
                    </li>
                    {consumerRoot && (
                        <li>
                            Consumer <code>{ENV_FILE}</code>:{' '}
                            {status.consumer.keyConfigured
                                ? 'đã cấu hình (phát hiện file, không đọc nội dung key)'
                                : status.consumer.envFileExists
                                  ? 'file có — key chưa hợp lệ / placeholder'
                                  : 'chưa có file'}
                        </li>
                    )}
                </ul>
            )}

            <div className="jev-smoke-test">
                <p className="text-sm m-0 mb-2">
                    <strong>Kiểm tra kết nối (tùy chọn)</strong> — dán key một lần; chỉ dùng để gọi smoke, không ghi
                    DB/git.
                </p>
                <label className="text-sm">
                    API key (ephemeral)
                    <input
                        type="password"
                        autoComplete="off"
                        placeholder="apikey_…"
                        value={pasteKey}
                        onChange={(e) => setPasteKey(e.target.value)}
                    />
                </label>
                <div className="flex flex-wrap gap-2 mt-2">
                    <button type="button" className="secondary" disabled={testing} onClick={() => void runSmoke()}>
                        {testing ? 'Đang gọi TypeSafe…' : 'Test kết nối Jev'}
                    </button>
                    {!pasteKey.trim() && (
                        <span className="sub text-xs self-center">Hoặc dùng TYPESAFE_API_KEY của process Console.</span>
                    )}
                </div>
                {testMsg && (
                    <p className={`text-sm mt-2 m-0 ${smokeOk ? 'text-green-300' : 'error'}`}>{testMsg}</p>
                )}
                {ready && !testMsg && (
                    <p className="text-sm text-green-300 m-0 mt-2">Jev sẵn sàng (env consumer/server hoặc test OK).</p>
                )}
            </div>

            {mode === 'shadow' && (
                <p className="sub text-xs m-0 mt-3">
                    Shadow: gọi TypeSafe để audit; không enforce route/guard. Key khuyến nghị nhưng không bắt buộc
                    trước provision.
                </p>
            )}
        </section>
    );
}
