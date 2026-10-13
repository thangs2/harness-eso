import { useMemo, useState } from 'react';
import type { RouteGraphDocument } from '@/shared/api/types';
import { FlowGraphSvg } from './FlowGraphSvg';
import type { FlowEdge, FlowNode } from '@/shared/graph/layoutLayered';

function asFlowGraph(doc: RouteGraphDocument): { nodes: FlowNode[]; edges: FlowEdge[] } | null {
    if (doc.nodes && Array.isArray(doc.nodes) && doc.edges && Array.isArray(doc.edges)) {
        return { nodes: doc.nodes as FlowNode[], edges: doc.edges as FlowEdge[] };
    }
    return null;
}

function flattenEntries(doc: RouteGraphDocument): Array<{ key: string; label: string; meta?: string }> {
    const rows: Array<{ key: string; label: string; meta?: string }> = [];
    const pushArr = (prefix: string, arr: unknown) => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            if (typeof item === 'string') rows.push({ key: `${prefix}:${item}`, label: item });
            else if (item && typeof item === 'object') {
                const o = item as Record<string, unknown>;
                const id = String(o.id ?? o.dirId ?? o.ruleId ?? o.path ?? rows.length);
                const label = String(o.label ?? o.name ?? o.title ?? id);
                const meta = [o.bucket, o.glob, o.path].filter(Boolean).join(' · ');
                rows.push({ key: `${prefix}:${id}`, label, meta: meta || undefined });
            }
        }
    };
    pushArr('surface', doc.surfaces);
    pushArr('rule', doc.rules);
    pushArr('skill', doc.skills);
    pushArr('dir', doc.dirs ?? doc.directories);
    if (doc.buckets && typeof doc.buckets === 'object') {
        for (const [k, v] of Object.entries(doc.buckets as Record<string, unknown>)) {
            rows.push({ key: `bucket:${k}`, label: k, meta: typeof v === 'string' ? v : JSON.stringify(v).slice(0, 80) });
        }
    }
    return rows;
}

export function RouteMapPanel({ doc }: { doc: RouteGraphDocument }) {
    const flow = useMemo(() => asFlowGraph(doc), [doc]);
    const flat = useMemo(() => (flow ? [] : flattenEntries(doc)), [doc, flow]);
    const [q, setQ] = useState('');

    if (flow) {
        return <FlowGraphSvg graph={flow} title="L0 route map (node graph)" />;
    }

    const filtered = flat.filter((r) => {
        if (!q.trim()) return true;
        const blob = `${r.label} ${r.meta || ''} ${r.key}`.toLowerCase();
        return blob.includes(q.trim().toLowerCase());
    });

    if (!flat.length) {
        return (
            <pre className="obs-mono mt-2 p-3 rounded bg-surface-raised overflow-auto max-h-96 text-xs">
                {JSON.stringify(doc, null, 2).slice(0, 8000)}
            </pre>
        );
    }

    return (
        <div>
            <input
                type="search"
                className="obs-search mb-3"
                placeholder="Filter surfaces, rules, skills…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
            />
            <p className="obs-sub m-0 mb-2">
                {filtered.length} / {flat.length} entries · artifact has no nodes/edges — list view
            </p>
            <div className="obs-table-wrap max-h-[32rem] overflow-y-auto">
                <table className="obs-table">
                    <thead>
                        <tr>
                            <th>Entry</th>
                            <th>Detail</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.slice(0, 500).map((r) => (
                            <tr key={r.key}>
                                <td>{r.label}</td>
                                <td className="obs-sub">{r.meta ?? r.key}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
