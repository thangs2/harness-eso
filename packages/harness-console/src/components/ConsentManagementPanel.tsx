import { type FormEvent, useEffect, useState } from 'react';
import {
    fetchConsent,
    grantConsent,
    revokeConsent,
    type ConsentRecord,
} from '@/api';

interface ConsentManagementPanelProps {
    projectId: string;
}

export function ConsentManagementPanel({ projectId }: ConsentManagementPanelProps) {
    const [live, setLive] = useState<ConsentRecord[]>([]);
    const [all, setAll] = useState<ConsentRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [path, setPath] = useState('');
    const [reason, setReason] = useState('');
    const [ttlMinutes, setTtlMinutes] = useState('30');
    const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function loadConsents() {
        if (!projectId) return;
        setLoading(true);
        try {
            const res = await fetchConsent(projectId);
            setLive(res.live || []);
            setAll(res.all || []);
        } catch (err) {
            setStatusMsg({ type: 'error', text: (err as Error).message });
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void loadConsents();
    }, [projectId]);

    async function onGrant(e: FormEvent) {
        e.preventDefault();
        if (!path.trim()) return;
        setSubmitting(true);
        setStatusMsg(null);
        try {
            const ttlSec = Number(ttlMinutes) * 60;
            const res = await grantConsent(projectId, {
                path: path.trim(),
                reason: reason.trim() || undefined,
                ttlSeconds: ttlSec > 0 ? ttlSec : undefined,
            });
            setStatusMsg({ type: 'ok', text: `Đã cấp quyền ghi cho "${res.record.path}"` });
            setPath('');
            setReason('');
            await loadConsents();
        } catch (err) {
            setStatusMsg({ type: 'error', text: (err as Error).message });
        } finally {
            setSubmitting(false);
        }
    }

    async function onRevoke(record: ConsentRecord) {
        if (!confirm(`Thu hồi quyền ghi cho path "${record.path}"?`)) return;
        try {
            await revokeConsent(projectId, { id: record.id });
            setStatusMsg({ type: 'ok', text: `Đã thu hồi quyền cho "${record.path}"` });
            await loadConsents();
        } catch (err) {
            setStatusMsg({ type: 'error', text: (err as Error).message });
        }
    }

    function formatExpires(iso: string) {
        try {
            const d = new Date(iso);
            const diffMs = d.getTime() - Date.now();
            if (diffMs <= 0) return 'Đã hết hạn';
            const mins = Math.round(diffMs / 60000);
            if (mins < 60) return `Còn ${mins} phút`;
            const hours = Math.round(mins / 60);
            return `Còn ~${hours} giờ (${d.toLocaleTimeString()})`;
        } catch {
            return iso;
        }
    }

    return (
        <div className="card mt-6">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold m-0">Quản lý Path Consent (Ask Tier)</h3>
                <button
                    type="button"
                    className="secondary text-xs px-2 py-1"
                    onClick={() => void loadConsents()}
                    disabled={loading}
                >
                    {loading ? 'Đang tải...' : 'Làm mới'}
                </button>
            </div>
            <p className="sub text-xs mb-4">
                Duyệt quyền ghi tạm thời cho các đường dẫn nhạy cảm được cấu hình thuộc nhóm <code>ask</code> trong{' '}
                <code>decision-policy.json</code>. Bản ghi consent lưu trong Product State ngoài repo.
            </p>

            {statusMsg && (
                <div
                    className={`text-xs p-2 rounded mb-4 ${
                        statusMsg.type === 'ok' ? 'bg-emerald-950 text-emerald-200 border border-emerald-800' : 'error'
                    }`}
                >
                    {statusMsg.text}
                </div>
            )}

            <div className="mb-6">
                <h4 className="text-sm font-medium mb-2">Quyền đang hiệu lực ({live.length})</h4>
                {live.length === 0 ? (
                    <p className="sub text-xs italic">Chưa có path nào được cấp consent.</p>
                ) : (
                    <ul className="list divide-y divide-surface-border">
                        {live.map((r) => (
                            <li key={r.id} className="py-2 flex items-center justify-between text-xs">
                                <div>
                                    <span className="font-mono font-semibold text-accent-link">{r.path}</span>
                                    <div className="sub mt-0.5">
                                        <span>{formatExpires(r.expiresAt)}</span>
                                        {r.reason ? <span> · Lý do: {r.reason}</span> : null}
                                        <span> · Bởi: {r.approvedBy}</span>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="secondary text-xs px-2 py-1 text-rose-400 hover:text-rose-300"
                                    onClick={() => void onRevoke(r)}
                                >
                                    Thu hồi
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <form onSubmit={(e) => void onGrant(e)} className="bg-surface-raised p-3 rounded-lg border border-surface-border">
                <h4 className="text-sm font-medium m-0 mb-1">Cấp quyền ghi tạm thời (Grant)</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <label className="text-xs">
                        Đường dẫn (Path)
                        <input
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            placeholder="vd. sdlc/08.wbs/"
                            required
                            className="text-xs py-1"
                        />
                    </label>
                    <label className="text-xs">
                        Lý do (tuỳ chọn)
                        <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="vd. Duyệt update WBS"
                            className="text-xs py-1"
                        />
                    </label>
                    <label className="text-xs">
                        Thời hạn (TTL)
                        <select
                            value={ttlMinutes}
                            onChange={(e) => setTtlMinutes(e.target.value)}
                            className="text-xs py-1"
                        >
                            <option value="15">15 phút</option>
                            <option value="30">30 phút (mặc định)</option>
                            <option value="60">1 giờ</option>
                            <option value="240">4 giờ</option>
                            <option value="1440">24 giờ</option>
                        </select>
                    </label>
                </div>
                <div className="flex justify-end mt-2">
                    <button type="submit" disabled={submitting || !path.trim()} className="text-xs py-1 px-3">
                        {submitting ? 'Đang cấp quyền...' : 'Cấp quyền (Grant)'}
                    </button>
                </div>
            </form>
        </div>
    );
}
