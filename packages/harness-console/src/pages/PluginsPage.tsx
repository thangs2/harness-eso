import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchPluginCatalog, getProject, patchProject, type PluginCatalog } from '@/api';
import { WizardSteps } from '@/WizardSteps';
import { PipelineIntro } from '@/components/PipelineIntro';
import { DiagramHint } from '@/components/DiagramHint';
import { getDiagram } from '@/diagrams/pipeline-diagrams';
import { MermaidPanel } from '@/components/MermaidPanel';
import { PostureAdvicePanel } from '@/components/PostureAdvicePanel';
import { JevKeyAdvice } from '@/components/JevKeyAdvice';

type SlotState = { adapterId: string; mode?: string; customLabel?: string };
type PluginsState = Record<string, SlotState>;

export function defaultPluginsState(): PluginsState {
    return {
        law: { adapterId: 'docgraph-cli' },
        code: { adapterId: 'codegraph-cli' },
        memory: { adapterId: 'noop-memory' },
        jev: { adapterId: 'off', mode: 'off' },
        l3_route: { adapterId: 'off' },
        brain: { adapterId: 'deepseek-mcp' },
    };
}

function normalizePlugins(raw: Record<string, unknown>): PluginsState {
    if (raw.law || raw.code || raw.memory) return raw as PluginsState;
    return {
        law: { adapterId: 'docgraph-cli' },
        code: { adapterId: 'codegraph-cli' },
        memory: {
            adapterId: (raw as { agentmemory?: { enabled?: boolean } }).agentmemory?.enabled
                ? 'agentmemory-mcp'
                : 'noop-memory',
        },
        jev: {
            adapterId: (raw as { jev?: { enabled?: boolean; mode?: string } }).jev?.enabled
                ? `jev-typesafe-${(raw as { jev?: { mode?: string } }).jev?.mode || 'shadow'}`
                : 'off',
            mode: (raw as { jev?: { mode?: string } }).jev?.mode || 'off',
        },
        l3_route: { adapterId: 'off' },
        brain: { adapterId: 'deepseek-mcp' },
    };
}

function jevModeFromAdapter(adapterId: string, mode?: string) {
    if (mode) return mode;
    if (adapterId.includes('active')) return 'active';
    if (adapterId.includes('shadow')) return 'shadow';
    return 'off';
}

export function PluginsPage() {
    const { id } = useParams();
    const nav = useNavigate();
    const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
    const [catalogNote, setCatalogNote] = useState<string | null>(null);
    const [plugins, setPlugins] = useState<PluginsState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [groupDiagramId, setGroupDiagramId] = useState<string | null>(null);
    const [consumerRoot, setConsumerRoot] = useState('');

    useEffect(() => {
        let cancelled = false;
        void fetchPluginCatalog()
            .then(({ catalog: c, source }) => {
                if (cancelled) return;
                setCatalog(c);
                if (source === 'embedded') {
                    setCatalogNote('Dùng catalog nhúng — chạy lại ./harness console để cập nhật API server.');
                }
            })
            .catch((e) => {
                if (!cancelled) setError((e as Error).message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!id) return;
        setPlugins(defaultPluginsState());
        void getProject(id)
            .then((r) => {
                setPlugins(normalizePlugins(r.project.plugins as Record<string, unknown>));
                setConsumerRoot(r.project.agentRepo?.root || '');
            })
            .catch((e) => setError((e as Error).message));
    }, [id]);

    function updateSlot(slotId: string, patch: Partial<SlotState>) {
        if (!plugins) return;
        const cur = plugins[slotId] || { adapterId: '' };
        const next = { ...plugins, [slotId]: { ...cur, ...patch } };
        if (slotId === 'jev' && patch.adapterId) {
            next.jev.mode = jevModeFromAdapter(patch.adapterId, patch.mode);
        }
        setPlugins(next);
    }

    async function onNext() {
        if (!id || !plugins) return;
        setError(null);
        try {
            await patchProject(id, { plugins });
            nav(`/projects/${id}/preview`);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    if (loading && !catalog) {
        return <p className="sub">Đang tải catalog…</p>;
    }

    if (!catalog || !plugins) {
        return (
            <div>
                <p className="error">{error || 'Không tải được cấu hình plug-in.'}</p>
                <button type="button" onClick={() => window.location.reload()}>Thử lại</button>
            </div>
        );
    }

    return (
        <div className="plugins-page">
            <WizardSteps current="plugins" />
            <h2>Plug-in & tích hợp</h2>
            {catalogNote && <p className="sub callout">{catalogNote}</p>}
            <PipelineIntro
                defaultDiagramId={catalog.pipelineIntro?.diagramId || 'v2-abcd'}
                primaryLabel={catalog.pipelineIntro?.label}
            />
            <PostureAdvicePanel plugins={plugins} />
            <JevKeyAdvice plugins={plugins} projectId={id} consumerRoot={consumerRoot || undefined} />
            <p className="sub">
                Chọn adapter cho từng vai trò. Bấm dòng gợi ý (hint) dưới mỗi lựa chọn để mở diagram pipeline.
            </p>

            {catalog.groups.map((group) => (
                <section key={group.id} className="plugin-group">
                    <header className="plugin-group__head">
                        <div>
                            <h3>{group.label}</h3>
                            {group.description && <p className="sub">{group.description}</p>}
                            {group.diagramId && (
                                <button
                                    type="button"
                                    className="linkish"
                                    onClick={() =>
                                        setGroupDiagramId((cur) => (cur === group.diagramId ? null : group.diagramId!))
                                    }
                                >
                                    {groupDiagramId === group.diagramId ? 'Ẩn diagram nhóm' : 'Xem vị trí trên pipeline'}
                                </button>
                            )}
                        </div>
                    </header>
                    {group.diagramId && groupDiagramId === group.diagramId && getDiagram(group.diagramId) && (
                        <MermaidPanel
                            diagram={getDiagram(group.diagramId)!}
                            onClose={() => setGroupDiagramId(null)}
                        />
                    )}

                    <div className="plugin-group__body">
                        {group.slots.map((slot) => {
                            const state = plugins[slot.id] || { adapterId: slot.options[0]?.id || '' };
                            const selected = slot.options.find((o) => o.id === state.adapterId);
                            const isCustom = !!selected?.custom;
                            const showJevSecrets =
                                slot.id === 'jev' &&
                                state.adapterId !== 'off' &&
                                slot.secrets &&
                                jevModeFromAdapter(state.adapterId, state.mode) !== 'off';

                            return (
                                <article key={slot.id} className="plugin-row-card">
                                    <div className="plugin-row-card__meta">
                                        {slot.kind && <span className="kind-tag">{slot.kind}</span>}
                                        <strong>{slot.label}</strong>
                                    </div>

                                    {slot.id === 'jev' ? (
                                        <div className="jev-modes" role="radiogroup" aria-label="Jev mode">
                                            {slot.options.map((o) => (
                                                <label key={o.id} className={`jev-pill ${state.adapterId === o.id ? 'on' : ''}`}>
                                                    <input
                                                        type="radio"
                                                        name="jev"
                                                        checked={state.adapterId === o.id}
                                                        onChange={() => updateSlot('jev', { adapterId: o.id, mode: o.mode })}
                                                    />
                                                    <span>{o.label}</span>
                                                </label>
                                            ))}
                                        </div>
                                    ) : (
                                        <select
                                            className="plugin-select"
                                            value={state.adapterId}
                                            onChange={(e) => {
                                                const opt = slot.options.find((o) => o.id === e.target.value);
                                                updateSlot(slot.id, {
                                                    adapterId: e.target.value,
                                                    mode: opt?.mode,
                                                    customLabel: opt?.custom ? state.customLabel : undefined,
                                                });
                                            }}
                                        >
                                            {slot.options.map((o) => (
                                                <option key={o.id} value={o.id}>{o.label}</option>
                                            ))}
                                        </select>
                                    )}

                                    {selected?.hint &&
                                        (selected.hintDiagram ? (
                                            <DiagramHint diagramId={selected.hintDiagram}>
                                                {selected.hint}
                                            </DiagramHint>
                                        ) : (
                                            <p className="hint">{selected.hint}</p>
                                        ))}

                                    {isCustom && (
                                        <label className="custom-label">
                                            Tên / id adapter custom
                                            <input
                                                value={state.customLabel || ''}
                                                onChange={(e) => updateSlot(slot.id, { customLabel: e.target.value })}
                                                placeholder="vd. notion-mcp, elasticsearch-law"
                                            />
                                        </label>
                                    )}

                                    {showJevSecrets && slot.secrets && (
                                        <div className="callout callout--warn">
                                            <strong>API key (không nhập trên web)</strong>
                                            <p>
                                                File <code>{slot.secrets.envFile}</code> trên repo agent · biến{' '}
                                                <code>{slot.secrets.envVar}</code> ·{' '}
                                                <a href={slot.secrets.doc} target="_blank" rel="noreferrer">
                                                    lấy key
                                                </a>
                                            </p>
                                            <p className="sub">{slot.secrets.note}</p>
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                </section>
            ))}

            <footer className="plugins-footer">
                <button type="button" onClick={() => void onNext()}>Tiếp — Xem trước</button>
            </footer>
            {error && <p className="error">{error}</p>}
        </div>
    );
}
